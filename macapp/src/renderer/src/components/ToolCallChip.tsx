function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ')
}

export function ToolCallChip({ name, args }: { name: string; args: Record<string, unknown> }) {
  return (
    <div className="chip">
      ↳ {name}({formatArgs(args)})
    </div>
  )
}

export function SpecialistStartChip({ name }: { name: string }) {
  return <div className="chip chip-dim">→ {name} agent</div>
}

export function SpecialistToolCallChip({
  agent,
  name,
  args
}: {
  agent: string
  name: string
  args: Record<string, unknown>
}) {
  return (
    <div className="chip">
      ↳ [{agent}] {name}({formatArgs(args)})
    </div>
  )
}
