import dotenv from 'dotenv'
dotenv.config({ path: './.env' })

import express from 'express'
import cors from 'cors'

import testRoutes from './routes/test.js'
import authRoutes from './routes/auth.js'
import timeRoutes from './routes/time.js'
import expensesRoutes from './routes/expenses.js'
import exportRoutes from './routes/export.js'
import adminRoutes from './routes/admin.js'
import calendarRoutes from './routes/calendar.js'

const app = express()

//Permite llamadas desde móvil
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
)

//Parsear JSON + formularios
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

//Rutas
app.use('/api', testRoutes)
app.use('/auth', authRoutes)
app.use('/time', timeRoutes)
app.use('/expenses', expensesRoutes)
app.use('/export', exportRoutes)
app.use('/admin', adminRoutes)
app.use('/calendar', calendarRoutes)

//Test básico
app.get('/', (req, res) => {
  res.send('API funcionando 🚀')
})

//Servidor accesible desde móvil
const PORT = process.env.PORT || 3000

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor en puerto ${PORT}`)
})

//Logs
console.log('ENV URL:', process.env.SUPABASE_URL)
console.log('Auth routes cargadas')
