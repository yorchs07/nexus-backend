import express from 'express'
import { supabase } from '../supabase.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminOnly } from '../middleware/admin.js'

const router = express.Router()

const BUCKET = 'expense-receipts'

//Helper: valida 'month' en formato YYYY-MM y devuelve los límites del mes
const parseMonth = (month) => {
  if (!month || typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    return null
  }
  const [yearStr, monthStr] = month.split('-')
  const year = parseInt(yearStr, 10)
  const monthNum = parseInt(monthStr, 10)
  if (monthNum < 1 || monthNum > 12) return null

  const fromDate = new Date(Date.UTC(year, monthNum - 1, 1, 0, 0, 0))
  const toDate = new Date(Date.UTC(year, monthNum, 1, 0, 0, 0))
  return { fromDate, toDate }
}

//Helper: enriquecer gastos con info del usuario en una sola consulta extra
const enrichExpensesWithUser = async (expenses) => {
  if (!expenses || expenses.length === 0) return expenses

  const userIds = [...new Set(expenses.map((e) => e.user_id))]
  const { data: users, error } = await supabase
    .from('profiles')
    .select('id, name, email, color')
    .in('id', userIds)

  if (error) return expenses

  const usersMap = Object.fromEntries(users.map((u) => [u.id, u]))
  return expenses.map((e) => ({
    ...e,
    user: usersMap[e.user_id] || null
  }))
}

//Listar usuarios/empleados
router.get('/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, name, role, color, created_at')
      .order('created_at', { ascending: false })

    if (error) return res.status(400).json({ error: error.message })

    res.json({ total: data.length, users: data })
  } catch (err) {
    console.error('Error en GET /admin/users:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

//Detalle de usuario
router.get('/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, name, role, color, created_at')
      .eq('id', id)
      .maybeSingle()

    if (error) return res.status(400).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Usuario no encontrado' })

    res.json({ user: data })
  } catch (err) {
    console.error('Error en GET /admin/users/:id:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

//Jornadas de usuario
router.get(
  '/users/:id/time-entries',
  authMiddleware,
  adminOnly,
  async (req, res) => {
    try {
      const { id } = req.params
      const { month } = req.query

      let query = supabase
        .from('time_entries')
        .select('*')
        .eq('user_id', id)
        .order('check_in', { ascending: false })

      if (month) {
        const range = parseMonth(month)
        if (!range) {
          return res.status(400).json({ error: 'Formato month inválido' })
        }
        query = query
          .gte('check_in', range.fromDate.toISOString())
          .lt('check_in', range.toDate.toISOString())
      }

      const { data, error } = await query

      if (error) return res.status(400).json({ error: error.message })

      res.json({ total: data.length, entries: data })
    } catch (err) {
      console.error('Error en GET /admin/users/:id/time-entries:', err)
      res.status(500).json({ error: 'Error interno del servidor' })
    }
  }
)

//Gastos de usuario
router.get(
  '/users/:id/expenses',
  authMiddleware,
  adminOnly,
  async (req, res) => {
    try {
      const { id } = req.params
      const { month } = req.query

      let query = supabase
        .from('expenses')
        .select('*')
        .eq('user_id', id)
        .order('created_at', { ascending: false })

      if (month) {
        const range = parseMonth(month)
        if (!range) {
          return res.status(400).json({ error: 'Formato month inválido' })
        }
        query = query
          .gte('created_at', range.fromDate.toISOString())
          .lt('created_at', range.toDate.toISOString())
      }

      const { data, error } = await query

      if (error) return res.status(400).json({ error: error.message })

      res.json({ total: data.length, expenses: data })
    } catch (err) {
      console.error('Error en GET /admin/users/:id/expenses:', err)
      res.status(500).json({ error: 'Error interno del servidor' })
    }
  }
)

//Url firmada de un recibo
router.get(
  '/expenses/:expenseId/receipt',
  authMiddleware,
  adminOnly,
  async (req, res) => {
    try {
      const { expenseId } = req.params

      const { data: expense, error: fetchError } = await supabase
        .from('expenses')
        .select('receipt_url')
        .eq('id', expenseId)
        .maybeSingle()

      if (fetchError) return res.status(400).json({ error: fetchError.message })
      if (!expense)
        return res.status(404).json({ error: 'Gasto no encontrado' })
      if (!expense.receipt_url) {
        return res.status(404).json({ error: 'Este gasto no tiene recibo' })
      }

      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(expense.receipt_url, 3600)

      if (error) return res.status(400).json({ error: error.message })

      res.json({ url: data.signedUrl, path: expense.receipt_url })
    } catch (err) {
      console.error('Error en GET /admin/expenses/:id/receipt:', err)
      res.status(500).json({ error: 'Error interno del servidor' })
    }
  }
)

//BANDEJA DE PENDIENTES
//Lista los gastos en estado 'pending'
router.get('/expenses/pending', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('expenses')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) return res.status(400).json({ error: error.message })

    const enriched = await enrichExpensesWithUser(data || [])

    res.json({ total: enriched.length, expenses: enriched })
  } catch (err) {
    console.error('Error en GET /admin/expenses/pending:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

//Aprobar un gasto
router.post(
  '/expenses/:id/approve',
  authMiddleware,
  adminOnly,
  async (req, res) => {
    try {
      const { id } = req.params

      const { data: existing, error: fetchError } = await supabase
        .from('expenses')
        .select('*')
        .eq('id', id)
        .maybeSingle()

      if (fetchError) return res.status(400).json({ error: fetchError.message })
      if (!existing)
        return res.status(404).json({ error: 'Gasto no encontrado' })

      if (existing.status === 'approved') {
        return res.status(400).json({ error: 'Este gasto ya está aprobado' })
      }

      const { data, error } = await supabase
        .from('expenses')
        .update({
          status: 'approved',
          approved_by: req.user.id,
          approved_at: new Date().toISOString(),
          rejection_reason: null
        })
        .eq('id', id)
        .select()
        .single()

      if (error) return res.status(400).json({ error: error.message })

      res.json({ message: 'Gasto aprobado', data })
    } catch (err) {
      console.error('Error en POST /admin/expenses/:id/approve:', err)
      res.status(500).json({ error: 'Error interno del servidor' })
    }
  }
)

//Rechazar un gasto
router.post(
  '/expenses/:id/reject',
  authMiddleware,
  adminOnly,
  async (req, res) => {
    try {
      const { id } = req.params
      const { reason } = req.body

      if (!reason || typeof reason !== 'string' || !reason.trim()) {
        return res
          .status(400)
          .json({ error: 'Debes indicar un motivo de rechazo' })
      }

      const { data: existing, error: fetchError } = await supabase
        .from('expenses')
        .select('*')
        .eq('id', id)
        .maybeSingle()

      if (fetchError) return res.status(400).json({ error: fetchError.message })
      if (!existing)
        return res.status(404).json({ error: 'Gasto no encontrado' })

      const { data, error } = await supabase
        .from('expenses')
        .update({
          status: 'rejected',
          approved_by: req.user.id,
          approved_at: new Date().toISOString(),
          rejection_reason: reason.trim()
        })
        .eq('id', id)
        .select()
        .single()

      if (error) return res.status(400).json({ error: error.message })

      res.json({ message: 'Gasto rechazado', data })
    } catch (err) {
      console.error('Error en POST /admin/expenses/:id/reject:', err)
      res.status(500).json({ error: 'Error interno del servidor' })
    }
  }
)

export default router
