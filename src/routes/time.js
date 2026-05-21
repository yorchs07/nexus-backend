import express from 'express'
import { supabase } from '../supabase.js'
import { authMiddleware } from '../middleware/auth.js'

const router = express.Router()

//CHECK-IN
router.post('/check-in', authMiddleware, async (req, res) => {
  const userId = req.user.id
  const { task } = req.body

  //Comprobar si ya hay fichaje abierto
  const { data: existing } = await supabase
    .from('time_entries')
    .select('*')
    .eq('user_id', userId)
    .is('check_out', null)
    .maybeSingle()

  if (existing) {
    return res.status(400).json({ error: 'Ya tienes un check-in activo' })
  }

  const { data, error } = await supabase
    .from('time_entries')
    .insert({
      user_id: userId,
      check_in: new Date(),
      task: task
    })
    .select()

  if (error) {
    return res.status(400).json({ error: error.message })
  }

  res.json({ message: 'Check-in registrado', data })
})

// JORNADA ACTIVA
router.get('/active', authMiddleware, async (req, res) => {
  const userId = req.user.id

  const { data, error } = await supabase
    .from('time_entries')
    .select('*')
    .eq('user_id', userId)
    .is('check_out', null)
    .order('check_in', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    return res.status(400).json({ error: error.message })
  }

  res.json({ active: data || null })
})

//CHECK-OUT
router.post('/check-out', authMiddleware, async (req, res) => {
  const userId = req.user.id

  const { data: entry } = await supabase
    .from('time_entries')
    .select('*')
    .eq('user_id', userId)
    .is('check_out', null)
    .order('check_in', { ascending: false })
    .limit(1)
    .single()

  if (!entry) {
    return res.status(400).json({ error: 'No hay check-in activo' })
  }

  const checkOutTime = new Date()

  const duration =
    (new Date(checkOutTime) - new Date(entry.check_in)) / 1000 / 60 / 60

  const { data, error } = await supabase
    .from('time_entries')
    .update({
      check_out: checkOutTime,
      hours: duration
    })
    .eq('id', entry.id)
    .select()

  if (error) {
    return res.status(400).json({ error: error.message })
  }

  res.json({
    message: 'Check-out registrado',
    hours: duration.toFixed(2),
    data
  })
})

//Historial
router.get('/history', authMiddleware, async (req, res) => {
  const userId = req.user.id

  const { data, error } = await supabase
    .from('time_entries')
    .select('*')
    .eq('user_id', userId)
    .order('check_in', { ascending: false })

  if (error) {
    return res.status(400).json({ error: error.message })
  }

  res.json({
    total: data.length,
    entries: data
  })
})

//Dashboard
// DASHBOARD
router.get('/stats', authMiddleware, async (req, res) => {
  const userId = req.user.id

  const { data, error } = await supabase
    .from('time_entries')
    .select('*')
    .eq('user_id', userId)
    .not('check_out', 'is', null)

  if (error) {
    return res.status(400).json({ error: error.message })
  }

  const now = new Date()

  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)

  const startOfWeek = new Date(now)
  startOfWeek.setDate(now.getDate() - now.getDay())

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  const calcStats = (entries, fromDate) => {
    const filtered = entries.filter((e) => new Date(e.check_in) >= fromDate)

    let totalMinutes = 0
    const byTask = {}

    filtered.forEach((e) => {
      const start = new Date(e.check_in)
      const end = new Date(e.check_out)

      const minutes = Math.floor((end - start) / 60000)
      totalMinutes += minutes

      const task = e.task || 'Trabajo'

      if (!byTask[task]) byTask[task] = 0
      byTask[task] += minutes
    })

    return { totalMinutes, byTask }
  }

  res.json({
    today: calcStats(data, startOfDay),
    week: calcStats(data, startOfWeek),
    month: calcStats(data, startOfMonth)
  })
})

export default router
