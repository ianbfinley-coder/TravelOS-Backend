// Events Routes
import express from 'express';
import { searchEvents } from '../services/external-apis/ticketmaster.js';

const router = express.Router();

router.get('/search', async (req, res) => {
  try {
    const { keyword, city } = req.query;
    const result = await searchEvents(keyword, city);
    res.json({ success: true, events: result.events });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
