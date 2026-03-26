import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST", "DELETE"]
    }
});

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static("public"));

app.get("/admin", (req, res) => {
    res.sendFile(process.cwd() + "/public/admin.html");
});

/* ---------------- DATABASE ---------------- */

const MONGO_URI = process.env.MONGODB_URI;
mongoose.set("bufferCommands", false);

let mapLayers = {}; // ✅ dynamic

const layerSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    geojson: { type: Object, required: true }
}, { timestamps: true });

const Layer = mongoose.model("Layer", layerSchema);

async function syncFromDB() {
    try {
        const layers = await Layer.find({});
        mapLayers = {};

        layers.forEach(l => {
            mapLayers[l.name] = l.geojson;
        });

        console.log("✅ Synced from DB");
        io.emit("geojson-update", mapLayers);
    } catch (err) {
        console.error("Sync error:", err);
    }
}

if (!MONGO_URI) {
    console.error("❌ MONGODB_URI missing");
} else {
    mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
        .then(() => {
            console.log("✅ MongoDB Connected");
            syncFromDB();
        })
        .catch(err => console.error(err));
}

/* ---------------- API ---------------- */

app.get("/api/geojson", (req, res) => {
    res.json(mapLayers);
});

app.post("/api/geojson", async (req, res) => {
    const { layer, geojson } = req.body;

    if (!layer || !geojson) {
        return res.status(400).json({ error: "Layer & GeoJSON required" });
    }

    if (geojson.type !== "FeatureCollection") {
        return res.status(400).json({ error: "Invalid GeoJSON" });
    }

    try {
        await Layer.findOneAndUpdate(
            { name: layer },
            { geojson },
            { upsert: true }
        );

        mapLayers[layer] = geojson;

        io.emit("geojson-update", mapLayers);

        res.json({ message: "Updated" });
    } catch (err) {
        res.status(500).json({ error: "DB error" });
    }
});

app.delete("/api/geojson/:layer", async (req, res) => {
    const { layer } = req.params;

    try {
        await Layer.findOneAndDelete({ name: layer });
        delete mapLayers[layer];

        io.emit("geojson-update", mapLayers);

        res.json({ message: "Deleted" });
    } catch {
        res.status(500).json({ error: "Delete failed" });
    }
});

/* ---------------- SOCKET ---------------- */

io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    socket.emit("geojson-update", mapLayers);
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});