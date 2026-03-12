import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static("public"));

app.get("/admin", (req, res) => {
    res.sendFile(process.cwd() + "/public/admin.html");
});

/* ---------------- MAP LAYERS STATE ---------------- */

let mapLayers = {
    panchayat: null,
    flood: null
};

/* ---------------- API ---------------- */

app.get("/api/geojson", (req, res) => {
    res.json(mapLayers);
});

app.post("/api/geojson", (req, res) => {

    const { layer, geojson } = req.body;

    if (!layer || !geojson) {
        return res.status(400).json({ error: "Layer and GeoJSON required" });
    }

    if (geojson.type !== "FeatureCollection") {
        return res.status(400).json({ error: "Invalid GeoJSON" });
    }

    mapLayers[layer] = geojson;

    console.log(`Layer updated: ${layer}`);

    io.emit("geojson-update", mapLayers);

    res.json({ message: "Layer updated successfully" });
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