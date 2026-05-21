import express from 'express'
import ExcelJS from 'exceljs'
import { supabase } from '../supabase.js'
import { authMiddleware } from '../middleware/auth.js'

const router = express.Router()

const VALID_STATUS_FILTERS = ['approved', 'pending', 'rejected', 'all']

//Exportar mes a excel
router.get('/monthly', authMiddleware, async (req, res) => {
  try {
    const { month, user_id: userIdParam, status: statusParam } = req.query

    if (!month || typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
      return res
        .status(400)
        .json({ error: "Parámetro 'month' requerido en formato YYYY-MM" })
    }

    const [yearStr, monthStr] = month.split('-')
    const year = parseInt(yearStr, 10)
    const monthNum = parseInt(monthStr, 10)

    if (monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ error: 'Mes inválido' })
    }

    //Validar status filter
    const statusFilter =
      statusParam && VALID_STATUS_FILTERS.includes(statusParam)
        ? statusParam
        : 'approved'

    //Determinar de qué usuario exportamos
    let targetUserId = req.user.id
    let targetEmail = req.user.email
    let targetName = req.user.name

    if (userIdParam && userIdParam !== req.user.id) {
      if (req.user.role !== 'admin') {
        return res
          .status(403)
          .json({ error: 'Acceso denegado: se requiere rol admin' })
      }

      const { data: target, error: targetErr } = await supabase
        .from('profiles')
        .select('id, email, name')
        .eq('id', userIdParam)
        .maybeSingle()

      if (targetErr) {
        return res.status(400).json({ error: targetErr.message })
      }
      if (!target) {
        return res.status(404).json({ error: 'Usuario no encontrado' })
      }

      targetUserId = target.id
      targetEmail = target.email
      targetName = target.name
    }

    const fromDate = new Date(Date.UTC(year, monthNum - 1, 1, 0, 0, 0))
    const toDate = new Date(Date.UTC(year, monthNum, 1, 0, 0, 0))

    //Jornadas
    const { data: timeEntries, error: timeErr } = await supabase
      .from('time_entries')
      .select('*')
      .eq('user_id', targetUserId)
      .gte('check_in', fromDate.toISOString())
      .lt('check_in', toDate.toISOString())
      .order('check_in', { ascending: true })

    if (timeErr) return res.status(400).json({ error: timeErr.message })

    //Gastos (filtrados por estado)
    let expensesQuery = supabase
      .from('expenses')
      .select('*')
      .eq('user_id', targetUserId)
      .gte('created_at', fromDate.toISOString())
      .lt('created_at', toDate.toISOString())
      .order('created_at', { ascending: true })

    if (statusFilter !== 'all') {
      expensesQuery = expensesQuery.eq('status', statusFilter)
    }

    const { data: expenses, error: expensesErr } = await expensesQuery

    if (expensesErr) {
      return res.status(400).json({ error: expensesErr.message })
    }

    //Construir workbook
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'Nexus by Balmis'
    workbook.created = new Date()

    //Hoja horas
    const sheetHours = workbook.addWorksheet('Horas', {
      views: [{ state: 'frozen', ySplit: 1 }]
    })

    sheetHours.columns = [
      { header: 'Fecha', key: 'date', width: 12 },
      { header: 'Entrada', key: 'checkIn', width: 10 },
      { header: 'Salida', key: 'checkOut', width: 10 },
      { header: 'Duración (min)', key: 'minutes', width: 14 },
      { header: 'Duración', key: 'duration', width: 12 },
      { header: 'Tarea', key: 'task', width: 20 }
    ]

    sheetHours.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    sheetHours.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4CAF50' }
    }
    sheetHours.getRow(1).alignment = {
      vertical: 'middle',
      horizontal: 'center'
    }

    let totalMinutesMonth = 0
    const byTask = {}

    for (const entry of timeEntries) {
      const checkIn = new Date(entry.check_in)
      const checkOut = entry.check_out ? new Date(entry.check_out) : null
      const minutes = checkOut
        ? Math.floor((checkOut.getTime() - checkIn.getTime()) / 60000)
        : 0

      const task = entry.task || 'Sin categoría'
      totalMinutesMonth += minutes
      byTask[task] = (byTask[task] || 0) + minutes

      sheetHours.addRow({
        date: checkIn.toLocaleDateString('es-ES'),
        checkIn: checkIn.toLocaleTimeString('es-ES', {
          hour: '2-digit',
          minute: '2-digit'
        }),
        checkOut: checkOut
          ? checkOut.toLocaleTimeString('es-ES', {
              hour: '2-digit',
              minute: '2-digit'
            })
          : '—',
        minutes,
        duration: formatDuration(minutes),
        task
      })
    }

    if (timeEntries.length > 0) {
      sheetHours.addRow({})
      const totalRow = sheetHours.addRow({
        date: 'TOTAL MES',
        minutes: totalMinutesMonth,
        duration: formatDuration(totalMinutesMonth)
      })
      totalRow.font = { bold: true }
      totalRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE8F5E9' }
      }

      sheetHours.addRow({})
      const byTaskHeader = sheetHours.addRow({ date: 'Totales por tarea' })
      byTaskHeader.font = { bold: true }

      for (const [task, mins] of Object.entries(byTask).sort(
        (a, b) => b[1] - a[1]
      )) {
        const pct =
          totalMinutesMonth > 0
            ? Math.round((mins / totalMinutesMonth) * 100) + '%'
            : '0%'
        sheetHours.addRow({
          date: task,
          minutes: mins,
          duration: formatDuration(mins),
          task: pct
        })
      }
    } else {
      sheetHours.addRow({ date: 'Sin jornadas en este mes' })
    }

    //Hoja gastos
    const sheetExpenses = workbook.addWorksheet('Gastos', {
      views: [{ state: 'frozen', ySplit: 1 }]
    })

    //Columnas: si exportamos 'all', incluir columna de Estado
    const includeStatusColumn = statusFilter === 'all'

    const expenseColumns = [
      { header: 'Fecha', key: 'date', width: 12 },
      { header: 'Concepto', key: 'concept', width: 35 },
      { header: 'Cantidad (€)', key: 'amount', width: 14 },
      { header: 'Recibo', key: 'receipt', width: 10 }
    ]
    if (includeStatusColumn) {
      expenseColumns.push({ header: 'Estado', key: 'status', width: 12 })
    }
    sheetExpenses.columns = expenseColumns

    sheetExpenses.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    sheetExpenses.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2196F3' }
    }
    sheetExpenses.getRow(1).alignment = {
      vertical: 'middle',
      horizontal: 'center'
    }

    let totalAmountMonth = 0

    const statusLabels = {
      pending: 'Pendiente',
      approved: 'Aprobado',
      rejected: 'Rechazado'
    }

    for (const exp of expenses) {
      const created = new Date(exp.created_at)
      const amount = Number(exp.amount) || 0
      totalAmountMonth += amount

      const row = {
        date: created.toLocaleDateString('es-ES'),
        concept: exp.concept,
        amount,
        receipt: exp.receipt_url ? 'Sí' : 'No'
      }
      if (includeStatusColumn) {
        row.status = statusLabels[exp.status] || exp.status
      }
      sheetExpenses.addRow(row)
    }

    sheetExpenses.getColumn('amount').numFmt = '#,##0.00 €'

    //Etiqueta del filtro arriba de la hoja como banner informativo
    const filterLabel = {
      approved: 'Solo gastos APROBADOS',
      pending: 'Solo gastos PENDIENTES',
      rejected: 'Solo gastos RECHAZADOS',
      all: 'TODOS los gastos (incluye pendientes y rechazados)'
    }[statusFilter]

    if (expenses.length > 0) {
      sheetExpenses.addRow({})
      const totalRow = sheetExpenses.addRow({
        date: 'TOTAL MES',
        amount: totalAmountMonth
      })
      totalRow.font = { bold: true }
      totalRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE3F2FD' }
      }
      totalRow.getCell('amount').numFmt = '#,##0.00 €'

      sheetExpenses.addRow({})
      const filterRow = sheetExpenses.addRow({ date: filterLabel })
      filterRow.font = { italic: true, color: { argb: 'FF555555' } }
    } else {
      sheetExpenses.addRow({ date: `Sin gastos (${filterLabel})` })
    }

    //Enviar
    const emailSafe = (targetEmail || 'usuario').replace(/[^a-zA-Z0-9]/g, '_')
    const filename = `nexus-${month}-${emailSafe}.xlsx`

    const buffer = await workbook.xlsx.writeBuffer()

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(Buffer.from(buffer))
  } catch (err) {
    console.error('Error en export/monthly:', err)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

function formatDuration(minutes) {
  if (!minutes) return '0 min'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  if (m === 0) return `${h}h`
  return `${h}h ${m}min`
}

export default router
