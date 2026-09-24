const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");

const dataDir = path.join(__dirname, ".data");
const dbFilePath = path.join(dataDir, "studybuddy_db.json");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let localStore = {};

function loadLocalStore() {
  try {
    if (fs.existsSync(dbFilePath)) {
      const raw = fs.readFileSync(dbFilePath, "utf8");
      localStore = JSON.parse(raw);
    }
  } catch (err) {
    console.error("[DB] Could not load local store, starting fresh:", err.message);
    localStore = {};
  }
}

function saveLocalStore() {
  try {
    fs.writeFileSync(dbFilePath, JSON.stringify(localStore, null, 2), "utf8");
  } catch (err) {
    console.error("[DB] Could not save local store:", err.message);
  }
}

loadLocalStore();

let isConnectedToAtlas = false;

function generateId() {
  return crypto.randomBytes(12).toString("hex");
}

function matchCriteria(doc, query = {}) {
  if (!query || Object.keys(query).length === 0) return true;
  for (const [key, val] of Object.entries(query)) {
    if (key === "$or" && Array.isArray(val)) {
      const orMatched = val.some((subQuery) => matchCriteria(doc, subQuery));
      if (!orMatched) return false;
      continue;
    }
    const docVal = doc[key];
    if (val instanceof RegExp) {
      if (!val.test(String(docVal || ""))) return false;
    } else if (typeof val === "object" && val !== null) {
      if (val.$regex) {
        const regex = new RegExp(val.$regex, val.$options || "i");
        if (!regex.test(String(docVal || ""))) return false;
      }
    } else {
      if (String(docVal) !== String(val)) return false;
    }
  }
  return true;
}

class LocalQuery {
  constructor(collectionName, query = {}, isSingle = false, isDelete = false) {
    this.collectionName = collectionName;
    this.query = query;
    this.isSingle = isSingle;
    this.isDelete = isDelete;
    this._sort = null;
    this._limit = null;
    this._excludeFields = [];
  }

  sort(s) {
    this._sort = s;
    return this;
  }

  limit(l) {
    this._limit = l;
    return this;
  }

  select(fields) {
    if (typeof fields === "string") {
      this._excludeFields = fields
        .split(" ")
        .filter((f) => f.startsWith("-"))
        .map((f) => f.slice(1));
    }
    return this;
  }

  async execute() {
    if (!localStore[this.collectionName]) {
      localStore[this.collectionName] = [];
    }
    const list = localStore[this.collectionName];

    if (this.isDelete) {
      const idx = list.findIndex((doc) => matchCriteria(doc, this.query));
      if (idx !== -1) {
        const [deleted] = list.splice(idx, 1);
        saveLocalStore();
        return deleted;
      }
      return null;
    }

    let results = list.filter((doc) => matchCriteria(doc, this.query));

    if (this._sort) {
      for (const [key, dir] of Object.entries(this._sort)) {
        const direction = dir === -1 || dir === "desc" ? -1 : 1;
        results.sort((a, b) => {
          const valA = a[key] || "";
          const valB = b[key] || "";
          if (valA < valB) return -1 * direction;
          if (valA > valB) return 1 * direction;
          return 0;
        });
      }
    }

    if (this._limit && this._limit > 0) {
      results = results.slice(0, this._limit);
    }

    if (this._excludeFields.length > 0) {
      results = results.map((doc) => {
        const copy = { ...doc };
        for (const f of this._excludeFields) {
          delete copy[f];
        }
        return copy;
      });
    }

    const wrapDoc = (doc) => {
      if (!doc) return null;
      return {
        ...doc,
        save: async function () {
          const idx = list.findIndex((d) => String(d._id) === String(doc._id));
          if (idx !== -1) {
            list[idx] = { ...this };
            saveLocalStore();
          }
          return this;
        },
      };
    };

    if (this.isSingle) {
      return wrapDoc(results[0] || null);
    }
    return results.map(wrapDoc);
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

function createModelWrapper(modelName, mongooseModel) {
  return {
    async create(data) {
      if (isConnectedToAtlas && mongoose.connection.readyState === 1) {
        return mongooseModel.create(data);
      }
      if (!localStore[modelName]) {
        localStore[modelName] = [];
      }
      const newDoc = {
        ...data,
        _id: generateId(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      localStore[modelName].push(newDoc);
      saveLocalStore();
      return {
        ...newDoc,
        save: async function () {
          const idx = localStore[modelName].findIndex((d) => String(d._id) === String(newDoc._id));
          if (idx !== -1) {
            localStore[modelName][idx] = { ...this };
            saveLocalStore();
          }
          return this;
        },
      };
    },

    find(query = {}) {
      if (isConnectedToAtlas && mongoose.connection.readyState === 1) {
        return mongooseModel.find(query);
      }
      return new LocalQuery(modelName, query, false);
    },

    findOne(query = {}) {
      if (isConnectedToAtlas && mongoose.connection.readyState === 1) {
        return mongooseModel.findOne(query);
      }
      return new LocalQuery(modelName, query, true);
    },

    findById(id) {
      if (isConnectedToAtlas && mongoose.connection.readyState === 1) {
        return mongooseModel.findById(id);
      }
      return new LocalQuery(modelName, { _id: String(id) }, true);
    },

    findOneAndDelete(query = {}) {
      if (isConnectedToAtlas && mongoose.connection.readyState === 1) {
        return mongooseModel.findOneAndDelete(query);
      }
      return new LocalQuery(modelName, query, true, true);
    },

    async findOneAndUpdate(query = {}, update = {}, options = {}) {
      if (isConnectedToAtlas && mongoose.connection.readyState === 1) {
        return mongooseModel.findOneAndUpdate(query, update, options);
      }
      if (!localStore[modelName]) {
        localStore[modelName] = [];
      }
      const list = localStore[modelName];
      let doc = list.find((d) => matchCriteria(d, query));

      if (!doc && options.upsert) {
        doc = {
          _id: generateId(),
          ...query,
          createdAt: new Date().toISOString(),
        };
        list.push(doc);
      }

      if (doc) {
        if (update.$set) {
          Object.assign(doc, update.$set);
        }
        if (update.$addToSet) {
          for (const [key, setVal] of Object.entries(update.$addToSet)) {
            if (!Array.isArray(doc[key])) doc[key] = [];
            const items = setVal.$each ? setVal.$each : [setVal];
            for (const item of items) {
              if (!doc[key].includes(item)) doc[key].push(item);
            }
          }
        }
        for (const [key, val] of Object.entries(update)) {
          if (!key.startsWith("$")) {
            doc[key] = val;
          }
        }
        doc.updatedAt = new Date().toISOString();
        saveLocalStore();
      }

      return doc;
    },
  };
}

async function initDatabase() {
  const uri = process.env.MONGO_URI || "";
  const hasPlaceholder = uri.includes("<db_password>") || uri.includes("<password>") || !uri;

  if (hasPlaceholder) {
    console.log("[StudyBuddy DB] MONGO_URI contains placeholder credentials (<db_password>).");
    console.log("[StudyBuddy DB] Active mode: Persistent local file database (.data/studybuddy_db.json).");
    console.log("[StudyBuddy DB] All registration, login, study materials, quizzes, and app lock features are active!");
    return;
  }

  try {
    console.log("[StudyBuddy DB] Connecting to MongoDB Atlas...");
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
    isConnectedToAtlas = true;
    console.log("[StudyBuddy DB] Connected to MongoDB Atlas successfully!");
  } catch (err) {
    console.warn("[StudyBuddy DB] Atlas connection failed:", err.message);
    console.log("[StudyBuddy DB] Active mode: Persistent local file database (.data/studybuddy_db.json).");
  }
}

module.exports = {
  initDatabase,
  createModelWrapper,
  get isConnectedToAtlas() {
    return isConnectedToAtlas;
  },
};
