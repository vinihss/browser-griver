import type { Repository } from "./db/repo.js"
import type { RunManager } from "./runner/index.js"
import { createPlaywrightDriver } from "./drivers/playwright.js"
import { createFirecrawlDriver } from "./drivers/firecrawl.js"

interface CronFields {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

/**
 * Agenda execuções automáticas a partir de expressões cron.
 *
 * Suporta os cinco campos usuais: `minuto hora dia mês dia-da-semana`,
 * com `*`, listas (`1,2`), intervalos (`1-5`) e `*\/n`.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined
  /** minuto já disparado por agendamento, para não repetir */
  private readonly fired = new Map<string, string>()

  constructor(
    private readonly repo: Repository,
    private readonly runs: RunManager,
    private readonly intervalMs = 30_000,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async tick(): Promise<void> {
    const now = new Date()
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`

    for (const schedule of this.repo.listSchedules()) {
      if (!schedule.enabled) continue
      if (this.fired.get(schedule.id) === minuteKey) continue

      const fields = parseCron(schedule.cron)
      if (!fields) continue
      if (!matches(fields, now)) continue

      this.fired.set(schedule.id, minuteKey)
      await this.execute(schedule.id, schedule.recipeId, schedule.driver)
    }
  }

  private async execute(scheduleId: string, recipeId: string, driver: string): Promise<void> {
    const found = this.repo.getRecipe(recipeId)
    if (!found) return

    try {
      await this.runs.start({
        recipe: found.body,
        recipeId: found.summary.id,
        recipeName: found.summary.name,
        driver,
        createDriver: async () => {
          if (found.summary.target === "os" || driver === "firecrawl") {
            return await createFirecrawlDriver({ apiKey: process.env.FIRECRAWL_API_KEY })
          }
          return await createPlaywrightDriver()
        },
      })
    } catch (error) {
      console.error("[scheduler] falha ao executar:", error)
    } finally {
      this.repo.markScheduleRun(scheduleId)
    }
  }
}

/** Converte uma expressão cron nos conjuntos de valores aceitos. */
export function parseCron(expression: string): CronFields | undefined {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return undefined

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]

  const parse = (field: string, min: number, max: number): number[] | undefined => {
    const values = new Set<number>()
    for (const piece of field.split(",")) {
      const [range, stepText] = piece.split("/")
      const step = stepText ? Number(stepText) : 1
      if (!Number.isFinite(step) || step <= 0) return undefined

      let from: number
      let to: number
      if (range === "*") {
        from = min
        to = max
      } else if (range?.includes("-")) {
        const [start, end] = range.split("-").map(Number)
        from = start ?? min
        to = end ?? max
      } else {
        from = Number(range)
        to = range === "*" ? max : from
      }
      if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined
      for (let value = from; value <= to; value += step) values.add(value)
    }
    return [...values]
  }

  const parsedMinute = parse(minute, 0, 59)
  const parsedHour = parse(hour, 0, 23)
  const parsedDay = parse(dayOfMonth, 1, 31)
  const parsedMonth = parse(month, 1, 12)
  const parsedWeek = parse(dayOfWeek, 0, 6)
  if (!parsedMinute || !parsedHour || !parsedDay || !parsedMonth || !parsedWeek) return undefined

  return {
    minute: parsedMinute,
    hour: parsedHour,
    dayOfMonth: parsedDay,
    month: parsedMonth,
    dayOfWeek: parsedWeek,
  }
}

/** Verifica se o instante bate com a expressão. */
export function matches(fields: CronFields, date: Date): boolean {
  if (!fields.minute.includes(date.getMinutes())) return false
  if (!fields.hour.includes(date.getHours())) return false
  if (!fields.month.includes(date.getMonth() + 1)) return false

  const dayOfMonth = fields.dayOfMonth.includes(date.getDate())
  const dayOfWeek = fields.dayOfWeek.includes(date.getDay())
  // quando dia e dia-da-semana estão restritos, qualquer um dos dois basta
  const dayRestricted = fields.dayOfMonth.length < 31
  const weekRestricted = fields.dayOfWeek.length < 7
  if (dayRestricted && weekRestricted) return dayOfMonth || dayOfWeek
  if (dayRestricted) return dayOfMonth
  if (weekRestricted) return dayOfWeek
  return true
}
