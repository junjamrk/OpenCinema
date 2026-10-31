export default function SettingFields({ rules, values, onChange, disabled }: { rules: Record<string, unknown>[]; values: Record<string, unknown>; onChange: (field: string, value: string | number | boolean) => void; disabled: boolean }) {
  return <>{rules.filter(rule => typeof rule.field === "string" && rule.field).map(rule => {
    const field = String(rule.field), label = String(rule.title || field), value = values[field] ?? rule.value ?? "";
    const props = rule.props && typeof rule.props === "object" ? rule.props as Record<string, unknown> : {};
    const options = Array.isArray(rule.options) ? rule.options as Record<string, unknown>[] : [];
    if (["switch", "checkbox"].includes(String(rule.type))) return <label className="settingToggle" key={field}><span>{label}</span><input type="checkbox" checked={value === true} disabled={disabled} onChange={event => onChange(field, event.target.checked)} /></label>;
    if (rule.type === "select" && options.length) return <label key={field}>{label}<select value={String(value)} disabled={disabled} onChange={event => { const selected = options.find(option => String(option.value) === event.target.value)?.value; onChange(field, typeof selected === "number" || typeof selected === "boolean" ? selected : String(selected ?? "")); }}>{options.map((option, index) => <option key={index} value={String(option.value)}>{String(option.label ?? option.value)}</option>)}</select></label>;
    const numeric = ["inputNumber", "slider"].includes(String(rule.type));
    const secret = props.type === "password" || /key|token|secret|password|credential/i.test(field);
    return <label key={field}>{label}<input type={numeric ? "number" : secret ? "password" : "text"} value={String(value)} disabled={disabled} autoComplete="off" placeholder={typeof props.placeholder === "string" ? props.placeholder : undefined} onChange={event => onChange(field, numeric ? Number(event.target.value) : event.target.value)} /></label>;
  })}</>;
}
