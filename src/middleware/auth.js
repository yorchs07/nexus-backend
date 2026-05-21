import { supabase } from '../supabase.js'

export const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader) {
      return res.status(401).json({ error: 'No autorizado' })
    }

    const token = authHeader.split(' ')[1]

    if (!token) {
      return res.status(401).json({ error: 'Token faltante' })
    }

    //Validación de usuario con Supabase
    const { data, error } = await supabase.auth.getUser(token)

    if (error || !data.user) {
      return res.status(401).json({ error: 'Token inválido' })
    }

    //Busca perfil en la tabla
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single()

    if (profileError || !profile) {
      return res.status(401).json({ error: 'Perfil no encontrado' })
    }

    req.user = profile

    next()
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Error interno' })
  }
}
