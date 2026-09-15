// Attractions Routes
import express from 'express';

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ attractions: [], message: 'Attractions endpoint' });
});

export default router;
