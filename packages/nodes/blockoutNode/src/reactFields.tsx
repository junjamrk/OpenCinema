import { useEffect, useState } from "react";

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.1,
  disabled,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(Number(value.toFixed(4)))), [value]);
  return (
    <label className="blockoutField">
      <span>{label}</span>
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = Number(draft);
          if (
            draft !== "" &&
            Number.isFinite(next) &&
            next !== value &&
            (min === undefined || next >= min) &&
            (max === undefined || next <= max)
          )
            onChange(next);
          else setDraft(String(value));
        }}
      />
    </label>
  );
}
