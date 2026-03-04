import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: '*', // Allow all origins for simplicity (Dev only)
        methods: ['GET', 'POST']
    }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Route for the admin portal
app.get('/admin', (req, res) => {
    res.sendFile(process.cwd() + '/public/admin.html');
});

let currentGeoJson = {
    "type": "FeatureCollection",
    "features": []
};

// --- API Endpoints ---

// Get current GeoJSON
app.get('/api/geojson', (req, res) => {
    res.json(currentGeoJson);
});

// Update GeoJSON
app.post('/api/geojson', (req, res) => {
    const geojson = req.body;

    if (!geojson || (geojson.type !== 'Feature' && geojson.type !== 'FeatureCollection')) {
        return res.status(400).json({ error: 'Invalid GeoJSON format' });
    }

    currentGeoJson = geojson;

    // Broadcast update to all connected clients
    io.emit('geojson-update', currentGeoJson);

    console.log('GeoJSON updated and broadcasted');
    res.json({ message: 'GeoJSON updated successfully' });
});

// Socket.io Connection
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Send current state on connection
    socket.emit('geojson-update', currentGeoJson);

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
