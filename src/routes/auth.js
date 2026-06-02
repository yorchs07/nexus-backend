import express from 'express'
import { supabase } from '../supabase.js'
import { authMiddleware } from '../middleware/auth.js'

const router = express.Router()

// Helper: validar formato hex (#RRGGBB)
const isValidHexColor = (s) =>
  typeof s === 'string' && /^#[0-9A-Fa-f]{6}$/.test(s)

//LOGIN
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    })

    if (error) {
      return res.status(400).json({ error: error.message })
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .maybeSingle()

    if (!profile) {
      const { data: newProfile, error: insertError } = await supabase
        .from('profiles')
        .insert({
          id: data.user.id,
          email: data.user.email
        })
        .select()

      if (insertError) {
      }
    } else {
    }

    res.json({
      token: data.session.access_token,
      user: data.user
    })
  } catch (err) {
    console.error('Error en login:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// DATOS DEL USUARIO AUTENTICADO
router.get('/me', authMiddleware, async (req, res) => {
  try {
    res.json({ user: req.user })
  } catch (err) {
    console.error('Error en /me:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// ACTUALIZAR PERFIL (name, color)
router.patch('/me', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const { name, color } = req.body

    const updates = {}

    if (name !== undefined) {
      if (typeof name !== 'string') {
        return res.status(400).json({ error: 'El nombre debe ser texto' })
      }
      const trimmed = name.trim()
      if (trimmed.length > 100) {
        return res.status(400).json({ error: 'El nombre es demasiado largo' })
      }
      updates.name = trimmed || null
    }

    if (color !== undefined) {
      if (color === null || color === '') {
        updates.color = null
      } else {
        if (!isValidHexColor(color)) {
          return res
            .status(400)
            .json({ error: 'Color inválido (formato esperado: #RRGGBB)' })
        }

        const { data: conflicts, error: conflictErr } = await supabase
          .from('profiles')
          .select('id')
          .eq('color', color)
          .neq('id', userId)

        if (conflictErr) {
          return res.status(400).json({ error: conflictErr.message })
        }
        if (conflicts && conflicts.length > 0) {
          return res
            .status(409)
            .json({ error: 'Ese color ya está siendo usado por otro empleado' })
        }

        updates.color = color
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ message: 'Sin cambios', user: req.user })
    }

    const { error: updateErr } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId)

    if (updateErr) {
      return res.status(400).json({ error: updateErr.message })
    }
    const { data: updated, error: selectErr } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)

    if (selectErr) {
      return res.status(400).json({ error: selectErr.message })
    }

    if (!updated || updated.length === 0) {
      return res.status(404).json({ error: 'Perfil no encontrado tras update' })
    }

    res.json({ message: 'Perfil actualizado', user: updated[0] })
  } catch (err) {
    console.error('Error en PATCH /me:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// COLORES YA OCUPADOS POR OTROS USUARIOS
// Devuelve un array de colores hex que ya tiene asignados algún OTRO empleado
router.get('/colors-taken', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id

    const { data, error } = await supabase
      .from('profiles')
      .select('color')
      .neq('id', userId)
      .not('color', 'is', null)

    if (error) return res.status(400).json({ error: error.message })

    const taken = data
      .map((r) => r.color)
      .filter((c) => typeof c === 'string' && c.length > 0)

    res.json({ taken })
  } catch (err) {
    console.error('Error en /colors-taken:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// CAMBIAR CONTRASEÑA
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body

    if (!currentPassword || typeof currentPassword !== 'string') {
      return res.status(400).json({ error: 'Contraseña actual requerida' })
    }

    if (!newPassword || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Nueva contraseña requerida' })
    }

    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' })
    }

    if (currentPassword === newPassword) {
      return res
        .status(400)
        .json({ error: 'La nueva contraseña debe ser distinta a la actual' })
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: req.user.email,
      password: currentPassword
    })

    if (signInError) {
      return res
        .status(400)
        .json({ error: 'La contraseña actual es incorrecta' })
    }

    const { error: updateError } = await supabase.auth.admin.updateUserById(
      req.user.id,
      { password: newPassword }
    )

    if (updateError) {
      return res.status(400).json({ error: updateError.message })
    }

    res.json({ message: 'Contraseña actualizada' })
  } catch (err) {
    console.error('Error en change-password:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

export default router
