require('dotenv').config();

const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(cors({
    origin: process.env.FRONTEND_URL || '*', // lock to your frontend domain
    methods: ['GET', 'POST', 'DELETE']
}));

// ── MongoDB Connection ────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => { console.error('❌ MongoDB error:', err); process.exit(1); });

// ── Room Schema ───────────────────────────────────────────────
const roomSchema = new mongoose.Schema({
    code:      { type: String, required: true, unique: true, length: 4 },
    text:      { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true }
});

// Auto-delete documents when expiresAt is reached (MongoDB TTL index)
// MongoDB checks every 60 seconds — rooms delete themselves automatically!
roomSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Room = mongoose.model('Room', roomSchema);

// ── Stats Schema (single document, running total) ─────────────
const statsSchema = new mongoose.Schema({
    totalTransfers: { type: Number, default: 0 }
});
const Stats = mongoose.model('Stats', statsSchema);

// Helper: get or create the single stats document
async function getStats() {
    let stats = await Stats.findOne();
    if (!stats) stats = await Stats.create({ totalTransfers: 0 });
    return stats;
}

// ── Routes ────────────────────────────────────────────────────

// Health check — Render pings this to keep your server alive
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'SnapClip API is running 🚀' });
});

// GET /api/stats — total transfers count
app.get('/api/stats', async (req, res) => {
    try {
        const stats = await getStats();
        res.json({ totalTransfers: stats.totalTransfers });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// POST /api/rooms — create a new room
// Body: { text: "your text here" }
app.post('/api/rooms', async (req, res) => {
    const { text } = req.body;

    if (!text || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
    }
    if (text.length > 50000) {
        return res.status(400).json({ error: 'Text too long (max 50,000 chars)' });
    }

    try {
        // Generate a unique 4-digit code (collision-safe)
        let code;
        let attempts = 0;
        while (attempts < 10) {
            code = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
            const exists = await Room.findOne({ code });
            if (!exists) break;
            attempts++;
            if (attempts === 10) {
                return res.status(503).json({ error: 'No codes available, try again' });
            }
        }

        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

        const room = await Room.create({ code, text: text.trim(), expiresAt });

        // Increment total transfers
        await Stats.updateOne({}, { $inc: { totalTransfers: 1 } }, { upsert: true });

        res.status(201).json({
            code:      room.code,
            expiresAt: room.expiresAt.toISOString()
        });

    } catch (err) {
        console.error('Create room error:', err);
        res.status(500).json({ error: 'Failed to create room' });
    }
});

// GET /api/rooms/:code — retrieve text by code
app.get('/api/rooms/:code', async (req, res) => {
    const { code } = req.params;

    if (!/^\d{4}$/.test(code)) {
        return res.status(400).json({ error: 'Invalid code format' });
    }

    try {
        const room = await Room.findOne({ code });

        if (!room) {
            return res.status(404).json({ error: 'Room not found or expired' });
        }

        // Double-check expiry (TTL index handles cleanup but has ~60s delay)
        if (room.expiresAt < new Date()) {
            await Room.deleteOne({ code });
            return res.status(404).json({ error: 'Room has expired' });
        }

        res.json({
            text:      room.text,
            expiresAt: room.expiresAt.toISOString()
        });

    } catch (err) {
        console.error('Get room error:', err);
        res.status(500).json({ error: 'Failed to retrieve room' });
    }
});

// DELETE /api/rooms/:code — manually delete a room (e.g. when timer hits 0)
app.delete('/api/rooms/:code', async (req, res) => {
    const { code } = req.params;
    try {
        await Room.deleteOne({ code });
        res.json({ message: 'Room deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete room' });
    }
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 SnapClip server running on port ${PORT}`);
});
