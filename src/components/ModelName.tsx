import type { ReactElement } from "react";

const GPT_56_VARIANT = /^(gpt-5\.6-)(luna|terra|sol)$/i;

interface ModelNameProps {
  value?: string;
  fallback?: string;
}

/** Keeps the GPT-5.6 family name neutral while tinting its variant suffix. */
export function ModelName({ value, fallback = "———" }: ModelNameProps): ReactElement {
  const match = value ? GPT_56_VARIANT.exec(value) : undefined;
  if (!match) return <>{value || fallback}</>;

  const suffix = match[2].toLocaleLowerCase();
  return <>
    {match[1]}
    <span className={`model-variant model-variant-${suffix}`}>{match[2]}</span>
  </>;
}
