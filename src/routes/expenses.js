import express from 'express'
import multer from 'multer'
import { supabase } from '../supabase.js'
import { authMiddleware } from '../middleware/auth.js'

const router = express.Router()
const BUCKET = 'expense-receipts'

// Multer en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
})

// Helper: subir un archivo al bucket. Devuelve { path, error }
const uploadFile = async (userId, file) => {
  const ext = (file.originalname.split('.').pop() || 'bin').toLowerCase()
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const path = `${userId}/${filename}`

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file.buffer, {
      contentType: file.mimetype,
      upsert: false
    })

  if (error) return { error: error.message }
  return { path }
}

// Helper: borrar archivo del bucket
const deleteFile = async (path) => {
  if (!path) return
  await supabase.storage.from(BUCKET).remove([path])
}

// LISTAR GASTOS DEL USUARIO
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('expenses')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })

    if (error) return res.status(400).json({ error: error.message })

    res.json({ total: data.length, expenses: data })
  } catch (err) {
    console.error('Error en GET /expenses:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// CREAR GASTO
router.post('/', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const { amount, concept } = req.body
    const file = req.file

    // Validaciones
    const amountNum = parseFloat(amount)
    if (isNaN(amountNum) || amountNum < 0) {
      return res.status(400).json({ error: 'Cantidad inválida' })
    }
    if (!concept || !concept.trim()) {
      return res.status(400).json({ error: 'Concepto requerido' })
    }

    let receiptPath = null
    if (file) {
      const up = await uploadFile(req.user.id, file)
      if (up.error) return res.status(400).json({ error: up.error })
      receiptPath = up.path
    }

    const { data, error } = await supabase
      .from('expenses')
      .insert({
        user_id: req.user.id,
        amount: amountNum,
        concept: concept.trim(),
        receipt_url: receiptPath,
        status: 'pending'
      })
      .select()
      .single()

    if (error) {
      // Limpieza si fallaba después de subir archivo
      if (receiptPath) await deleteFile(receiptPath)
      return res.status(400).json({ error: error.message })
    }

    res.json({ message: 'Gasto creado', data })
  } catch (err) {
    console.error('Error en POST /expenses:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// EDITAR GASTO
router.patch(
  '/:id',
  authMiddleware,
  upload.single('file'),
  async (req, res) => {
    try {
      const { id } = req.params
      const { amount, concept, remove_file } = req.body
      const file = req.file

      // Buscar el gasto existente
      const { data: existing, error: fetchError } = await supabase
        .from('expenses')
        .select('*')
        .eq('id', id)
        .maybeSingle()

      if (fetchError) return res.status(400).json({ error: fetchError.message })
      if (!existing)
        return res.status(404).json({ error: 'Gasto no encontrado' })

      // Solo el dueño puede editar
      if (existing.user_id !== req.user.id) {
        return res.status(403).json({ error: 'No puedes editar gastos ajenos' })
      }

      // Si el gasto está aprobado, no se puede editar
      if (existing.status === 'approved') {
        return res.status(403).json({
          error:
            'Este gasto ya está aprobado y no se puede modificar. Pide al administrador que lo rechace primero si necesitas cambiarlo.'
        })
      }

      // Validar campos
      const updates = {}
      if (amount !== undefined) {
        const amountNum = parseFloat(amount)
        if (isNaN(amountNum) || amountNum < 0) {
          return res.status(400).json({ error: 'Cantidad inválida' })
        }
        updates.amount = amountNum
      }
      if (concept !== undefined) {
        if (!concept.trim()) {
          return res.status(400).json({ error: 'Concepto requerido' })
        }
        updates.concept = concept.trim()
      }

      // Manejo del archivo: tres casos
      // - file presente → reemplaza el actual
      // - remove_file === 'true' → quita el actual
      // - nada → deja el actual
      if (file) {
        const up = await uploadFile(req.user.id, file)
        if (up.error) return res.status(400).json({ error: up.error })
        if (existing.receipt_url) {
          await deleteFile(existing.receipt_url)
        }
        updates.receipt_url = up.path
      } else if (remove_file === 'true') {
        if (existing.receipt_url) {
          await deleteFile(existing.receipt_url)
        }
        updates.receipt_url = null
      }

      // Si el gasto estaba rechazado, al editar vuelve a pending
      // y se limpia el motivo de rechazo + aprobador
      if (existing.status === 'rejected') {
        updates.status = 'pending'
        updates.rejection_reason = null
        updates.approved_by = null
        updates.approved_at = null
      }

      if (Object.keys(updates).length === 0) {
        return res.json({ message: 'Sin cambios', data: existing })
      }

      const { data, error } = await supabase
        .from('expenses')
        .update(updates)
        .eq('id', id)
        .select()
        .single()

      if (error) return res.status(400).json({ error: error.message })

      res.json({ message: 'Gasto actualizado', data })
    } catch (err) {
      console.error('Error en PATCH /expenses/:id:', err)
      res.status(500).json({ error: 'Error interno del servidor' })
    }
  }
)

// BORRAR GASTO
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params

    const { data: existing, error: fetchError } = await supabase
      .from('expenses')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (fetchError) return res.status(400).json({ error: fetchError.message })
    if (!existing) return res.status(404).json({ error: 'Gasto no encontrado' })

    if (existing.user_id !== req.user.id) {
      return res.status(403).json({ error: 'No puedes borrar gastos ajenos' })
    }

    // No permitimos borrar gastos aprobados
    if (existing.status === 'approved') {
      return res.status(403).json({
        error:
          'Este gasto ya está aprobado y no se puede borrar. Pide al administrador que lo rechace primero.'
      })
    }

    if (existing.receipt_url) {
      await deleteFile(existing.receipt_url)
    }

    const { error } = await supabase.from('expenses').delete().eq('id', id)
    if (error) return res.status(400).json({ error: error.message })

    res.json({ message: 'Gasto eliminado' })
  } catch (err) {
    console.error('Error en DELETE /expenses/:id:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// URL FIRMADA DEL RECIBO DEL USUARIO
router.get('/:id/receipt', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params

    const { data: expense, error: fetchError } = await supabase
      .from('expenses')
      .select('user_id, receipt_url')
      .eq('id', id)
      .maybeSingle()

    if (fetchError) return res.status(400).json({ error: fetchError.message })
    if (!expense) return res.status(404).json({ error: 'Gasto no encontrado' })
    if (expense.user_id !== req.user.id) {
      return res.status(403).json({ error: 'No puedes ver recibos ajenos' })
    }
    if (!expense.receipt_url) {
      return res.status(404).json({ error: 'Este gasto no tiene recibo' })
    }

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(expense.receipt_url, 3600)

    if (error) return res.status(400).json({ error: error.message })

    res.json({ url: data.signedUrl, path: expense.receipt_url })
  } catch (err) {
    console.error('Error en GET /expenses/:id/receipt:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

export default router
