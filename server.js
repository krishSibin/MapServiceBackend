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

/* ---------------- DATABASE CONFIG ---------------- */

const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI) {
    console.error("FATAL: MONGODB_URI is not defined in .env file");
} else {
    mongoose.connect(MONGO_URI)
        .then(() => {
            console.log("✓ Connected to MongoDB Atlas");
            syncFromDB(); // Sync after connection
        })
        .catch(err => console.error("MongoDB connection error:", err));
}

const layerSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    geojson: { type: Object, required: true }
}, { timestamps: true });

const Layer = mongoose.model("Layer", layerSchema);

/* ---------------- MAP LAYERS STATE ---------------- */

let mapLayers = {
    panchayat: null,
    flood: null
};

// Load initial data from MongoDB
async function syncFromDB() {
    try {
        const layers = await Layer.find({});
        layers.forEach(l => {
            if (mapLayers.hasOwnProperty(l.name)) {
                mapLayers[l.name] = l.geojson;
            }
        });
        console.log("State synchronized with MongoDB");
        io.emit("geojson-update", mapLayers);
    } catch (err) {
        console.error("Sync error:", err);
    }
}

/* ---------------- API ---------------- */

app.get("/api/geojson", (req, res) => {
    res.json(mapLayers);
});

app.post("/api/geojson", async (req, res) => {
    const { layer, geojson } = req.body;

    if (!layer || !geojson) {
        return res.status(400).json({ error: "Layer and GeoJSON required" });
    }

    if (geojson.type !== "FeatureCollection") {
        return res.status(400).json({ error: "Invalid GeoJSON" });
    }

    try {
        // Save/Update in MongoDB
        await Layer.findOneAndUpdate(
            { name: layer },
            { geojson: geojson },
            { upsert: true, new: true }
        );

        // Update local state and notify clients
        mapLayers[layer] = geojson;
        console.log(`Layer updated in DB: ${layer}`);
        io.emit("geojson-update", mapLayers);

        res.json({ message: "Layer updated and saved to MongoDB" });
    } catch (err) {
        console.error("DB Save error:", err);
        res.status(500).json({ error: "Failed to save to database" });
    }
});

app.delete("/api/geojson/:layer", async (req, res) => {
    const { layer } = req.params;

    if (!mapLayers.hasOwnProperty(layer)) {
        return res.status(404).json({ error: "Layer not found" });
    }

    try {
        // Remove from MongoDB
        await Layer.findOneAndDelete({ name: layer });

        // Update local state and notify clients
        mapLayers[layer] = null;
        console.log(`Layer deleted from DB: ${layer}`);
        io.emit("geojson-update", mapLayers);

        res.json({ message: "Layer deleted from MongoDB" });
    } catch (err) {
        console.error("DB Delete error:", err);
        res.status(500).json({ error: "Failed to delete from database" });
    }
});

/* ---------------- SOCKET ---------------- */

io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    socket.emit("geojson-update", mapLayers);

    socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id);
    });
});

const PORT = process.env.PORT || 4000;

httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});