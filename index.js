require("dotenv").config();

const express = require("express");
const cors = require("cors");
const dns = require("node:dns");
const { initDatabase, isConnectedToAtlas } = require("./db");
const authRoutes = require("./routes/authRoutes");
const materialRoutes = require("./routes/materialRoutes");
const aiRoutes = require("./routes/aiRoutes");

const app = express();

// Use reliable recursive resolvers
try {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
} catch (e) {
  // Ignore DNS config warnings in non-standard environments
}

console.log("Gemini API key loaded:", !!process.env.GEMINI_API_KEY);

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/api/auth", authRoutes);
app.use("/api/material", materialRoutes);
app.use("/api/ai", aiRoutes);

app.get("/", (req, res) => {
  res.send("AI StudyBuddy Backend Running!");
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    app: "AI StudyBuddy Backend",
    database: isConnectedToAtlas ? "MongoDB Atlas" : "Local Persistent JSON DB",
    gemini: !!process.env.GEMINI_API_KEY,
    time: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 5000;

// Initialize database with automatic fallback
initDatabase().catch(err => console.error("Database init error:", err));

app.listen(PORT, () => {
  console.log(`AI StudyBuddy Server running on port ${PORT}`);
});
