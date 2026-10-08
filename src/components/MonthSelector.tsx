import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PRESET_OPTIONS = [1, 3, 6, 12];
const MIN_MONTHS = 1;
const MAX_MONTHS = 24;

type MonthSelectorProps = {
  months: number;
  onChange: (months: number) => void;
  disabled?: boolean;
  size?: "default" | "sm" | "lg";
};

/** Preset month buttons (1/3/6/12) plus a "Custom" option with a 1–24 input. */
export function MonthSelector({ months, onChange, disabled, size = "default" }: MonthSelectorProps) {
  const [customOpen, setCustomOpen] = useState(() => !PRESET_OPTIONS.includes(months));
  const [text, setText] = useState(String(months));

  useEffect(() => {
    setText(String(months));
  }, [months]);

  const commit = (value: string) => {
    setText(value);
    const n = parseInt(value, 10);
    if (!Number.isNaN(n)) onChange(Math.min(MAX_MONTHS, Math.max(MIN_MONTHS, n)));
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-5 gap-2">
        {PRESET_OPTIONS.map((m) => (
          <Button
            key={m}
            size={size}
            variant={!customOpen && months === m ? "default" : "outline"}
            disabled={disabled}
            onClick={() => {
              setCustomOpen(false);
              onChange(m);
            }}
          >
            {m}
          </Button>
        ))}
        <Button
          size={size}
          variant={customOpen ? "default" : "outline"}
          disabled={disabled}
          onClick={() => setCustomOpen(true)}
        >
          Custom
        </Button>
      </div>
      {customOpen && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={MIN_MONTHS}
            max={MAX_MONTHS}
            inputMode="numeric"
            value={text}
            disabled={disabled}
            onChange={(e) => commit(e.target.value)}
            onBlur={() => setText(String(months))}
            className="w-24 text-center"
            aria-label="Custom number of months"
          />
          <span className="text-xs text-muted-foreground">month{months === 1 ? "" : "s"} (max {MAX_MONTHS})</span>
        </div>
      )}
    </div>
  );
}
