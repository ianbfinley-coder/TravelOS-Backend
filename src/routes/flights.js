// Flights Routes
import express from 'express';
import { getFlights } from '../services/external-apis/flightaware.js';

const router = express.Router();

router.get('/search', async (req, res) => {
  try {
    const { departure, arrival, date } = req.query;
    const result = await getFlights(departure, arrival, date);
    res.json({ success: true, flights: result.flights });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
