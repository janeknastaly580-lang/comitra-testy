import { COUNTRIES } from '../lib/countries';
import { Input, Select } from './ui';

/**
 * A phone-number entry: a country dial-code picker (all countries) plus the
 * national number. The parent keeps the country ISO and the number separately;
 * combine them with `fullPhone()` when submitting.
 */
export default function PhoneField({
  iso,
  number,
  onIso,
  onNumber,
  placeholder = '500 100 200',
}: {
  iso: string;
  number: string;
  onIso: (iso: string) => void;
  onNumber: (number: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="grid grid-cols-5 gap-2">
      <Select
        value={iso}
        onChange={(e) => onIso(e.target.value)}
        aria-label="Country code"
        className="col-span-2"
      >
        {COUNTRIES.map((c) => (
          <option key={c.iso} value={c.iso}>
            {c.flag} {c.dial} · {c.name}
          </option>
        ))}
      </Select>
      <div className="col-span-3">
        <Input
          inputMode="tel"
          value={number}
          onChange={(e) => onNumber(e.target.value)}
          placeholder={placeholder}
        />
      </div>
    </div>
  );
}
