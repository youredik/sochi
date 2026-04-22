import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

type HealthResponse = {
	status: 'ok' | 'degraded'
	ydb: { connected: boolean; error?: string }
	time: string
}

export const Route = createFileRoute('/')({
	component: HomePage,
})

function HomePage() {
	const health = useQuery<HealthResponse>({
		queryKey: ['health', 'db'],
		queryFn: async () => {
			const res = await fetch(`${API_URL}/health/db`)
			return (await res.json()) as HealthResponse
		},
		refetchInterval: 5_000,
	})

	return (
		<main className="mx-auto max-w-3xl px-6 py-16">
			<h1 className="text-4xl font-semibold tracking-tight">HoReCa Portal</h1>
			<p className="mt-2 text-neutral-400">
				PMS для малого бизнеса гостеприимства в регионе Большого Сочи
			</p>

			<section className="mt-10 rounded-lg border border-neutral-800 p-6">
				<h2 className="text-lg font-medium">Системный статус</h2>
				<dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
					<dt className="text-neutral-500">Backend</dt>
					<dd>
						{health.isPending && <span className="text-neutral-500">проверяем…</span>}
						{health.isError && <span className="text-red-400">недоступен</span>}
						{health.data && (
							<span
								className={
									health.data.status === 'ok' ? 'text-emerald-400' : 'text-amber-400'
								}
							>
								{health.data.status}
							</span>
						)}
					</dd>
					<dt className="text-neutral-500">YDB</dt>
					<dd>
						{health.data?.ydb.connected ? (
							<span className="text-emerald-400">connected</span>
						) : (
							<span className="text-red-400">
								{health.data?.ydb.error ?? 'disconnected'}
							</span>
						)}
					</dd>
					<dt className="text-neutral-500">Последняя проверка</dt>
					<dd className="text-neutral-400">
						{health.data?.time
							? new Date(health.data.time).toLocaleTimeString('ru-RU')
							: '—'}
					</dd>
				</dl>
			</section>

			<footer className="mt-12 text-xs text-neutral-600">
				Node {import.meta.env.MODE} · API: {API_URL}
			</footer>
		</main>
	)
}
