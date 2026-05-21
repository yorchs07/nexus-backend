import express from 'express'
import { authMiddleware } from '../middleware/auth.js'

const router = express.Router()

router.get('/private', authMiddleware, (req, res) => {
  res.json({
    message: 'Ruta privada OK',
    user: req.user
  })
})

export default router
