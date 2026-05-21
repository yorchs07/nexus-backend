import express from 'express'
import { supabase } from '../supabase.js'
import { authMiddleware } from '../middleware/auth.js'

const router = express.Router()

// Helper: validar formato de fecha YYYY-MM-DD
const isValidDate = (s) =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

// Helper: validar formato de hora HH:MM o HH:MM:SS
const isValidTime = (s) =>
  typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s)

// Helper: validar formato YYYY-MM
const parseMonth = (month) => {
  if (!month || typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    return null
  }
  const [yearStr, monthStr] = month.split('-')
  const year = parseInt(yearStr, 10)
  const monthNum = parseInt(monthStr, 10)
  if (monthNum < 1 || monthNum > 12) return null

  const fromDate = new Date(Date.UTC(year, monthNum - 1, 1))
  const toDate = new Date(Date.UTC(year, monthNum, 1))

  return {
    fromStr: fromDate.toISOString().slice(0, 10),
    toStr: toDate.toISOString().slice(0, 10)
  }
}

// Categorías permitidas (mismas que el check-in)
const ALLOWED_ACTIVITIES = [
  'Trabajo personal',
  'Auditorías',
  'Reuniones',
  'Muestreos'
]

// LISTAR ENTRADAS DEL MES (con info del autor)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { month } = req.query

    if (!month) {
      return res
        .status(400)
        .json({ error: "Parámetro 'month' requerido en formato YYYY-MM" })
    }

    const range = parseMonth(month)
    if (!range) {
      return res.status(400).json({ error: 'Formato month inválido' })
    }

    // 1) Entradas del mes
    const { data: entries, error: entriesErr } = await supabase
      .from('calendar_entries')
      .select('*')
      .gte('date', range.fromStr)
      .lt('date', range.toStr)
      .order('date', { ascending: true })
      .order('start_time', { ascending: true })

    if (entriesErr) {
      return res.status(400).json({ error: entriesErr.message })
    }

    // 2) Conjunto de user_ids para enriquecer con nombre y color en una sola consulta
    const userIds = [...new Set(entries.map((e) => e.user_id))]

    let usersMap = {}
    if (userIds.length > 0) {
      const { data: users, error: usersErr } = await supabase
        .from('profiles')
        .select('id, name, email, color')
        .in('id', userIds)

      if (usersErr) {
        return res.status(400).json({ error: usersErr.message })
      }

      usersMap = Object.fromEntries(users.map((u) => [u.id, u]))
    }

    // 3) Combinar
    const enriched = entries.map((e) => ({
      ...e,
      user: usersMap[e.user_id] || null
    }))

    res.json({
      total: enriched.length,
      entries: enriched
    })
  } catch (err) {
    console.error('Error en GET /calendar:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// CREAR ENTRADA
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { date, start_time, end_time, activity, note, user_id } = req.body

    // Validaciones
    if (!isValidDate(date)) {
      return res
        .status(400)
        .json({ error: 'Fecha inválida (formato YYYY-MM-DD)' })
    }
    if (!isValidTime(start_time)) {
      return res.status(400).json({ error: 'Hora inicio inválida' })
    }
    if (!isValidTime(end_time)) {
      return res.status(400).json({ error: 'Hora fin inválida' })
    }
    if (!ALLOWED_ACTIVITIES.includes(activity)) {
      return res.status(400).json({
        error: `Actividad inválida. Opciones: ${ALLOWED_ACTIVITIES.join(', ')}`
      })
    }
    if (start_time >= end_time) {
      return res
        .status(400)
        .json({ error: 'La hora de fin debe ser posterior a la de inicio' })
    }

    // Determinar a qué user_id pertenece la entrada
    let targetUserId = req.user.id
    if (user_id && user_id !== req.user.id) {
      // Solo admin puede crear entradas para otros
      if (req.user.role !== 'admin') {
        return res
          .status(403)
          .json({
            error: 'Solo el admin puede crear entradas para otros usuarios'
          })
      }
      targetUserId = user_id
    }

    const { data, error } = await supabase
      .from('calendar_entries')
      .insert({
        user_id: targetUserId,
        date,
        start_time,
        end_time,
        activity,
        note: note || null
      })
      .select()
      .single()

    if (error) {
      return res.status(400).json({ error: error.message })
    }

    res.json({ message: 'Entrada creada', data })
  } catch (err) {
    console.error('Error en POST /calendar:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// ACTUALIZAR ENTRADA
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const { date, start_time, end_time, activity, note } = req.body

    // Comprobar que la entrada existe y obtener su dueño
    const { data: existing, error: fetchError } = await supabase
      .from('calendar_entries')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (fetchError) return res.status(400).json({ error: fetchError.message })
    if (!existing)
      return res.status(404).json({ error: 'Entrada no encontrada' })

    // Solo el dueño o un admin puede editar
    const isOwner = existing.user_id === req.user.id
    const isAdmin = req.user.role === 'admin'
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'No puedes editar entradas ajenas' })
    }

    // Construir actualizaciones validando lo que venga
    const updates = {}

    if (date !== undefined) {
      if (!isValidDate(date)) {
        return res.status(400).json({ error: 'Fecha inválida' })
      }
      updates.date = date
    }
    if (start_time !== undefined) {
      if (!isValidTime(start_time)) {
        return res.status(400).json({ error: 'Hora inicio inválida' })
      }
      updates.start_time = start_time
    }
    if (end_time !== undefined) {
      if (!isValidTime(end_time)) {
        return res.status(400).json({ error: 'Hora fin inválida' })
      }
      updates.end_time = end_time
    }
    if (activity !== undefined) {
      if (!ALLOWED_ACTIVITIES.includes(activity)) {
        return res.status(400).json({ error: 'Actividad inválida' })
      }
      updates.activity = activity
    }
    if (note !== undefined) {
      updates.note = note || null
    }

    // Validar coherencia start < end con los valores finales
    const finalStart = updates.start_time ?? existing.start_time
    const finalEnd = updates.end_time ?? existing.end_time
    if (finalStart >= finalEnd) {
      return res
        .status(400)
        .json({ error: 'La hora de fin debe ser posterior a la de inicio' })
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ message: 'Sin cambios', data: existing })
    }

    const { data, error } = await supabase
      .from('calendar_entries')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) return res.status(400).json({ error: error.message })

    res.json({ message: 'Entrada actualizada', data })
  } catch (err) {
    console.error('Error en PATCH /calendar/:id:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// BORRAR ENTRADA
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params

    const { data: existing, error: fetchError } = await supabase
      .from('calendar_entries')
      .select('user_id')
      .eq('id', id)
      .maybeSingle()

    if (fetchError) return res.status(400).json({ error: fetchError.message })
    if (!existing)
      return res.status(404).json({ error: 'Entrada no encontrada' })

    const isOwner = existing.user_id === req.user.id
    const isAdmin = req.user.role === 'admin'
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'No puedes borrar entradas ajenas' })
    }

    const { error } = await supabase
      .from('calendar_entries')
      .delete()
      .eq('id', id)

    if (error) return res.status(400).json({ error: error.message })

    res.json({ message: 'Entrada eliminada' })
  } catch (err) {
    console.error('Error en DELETE /calendar/:id:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

export default router
