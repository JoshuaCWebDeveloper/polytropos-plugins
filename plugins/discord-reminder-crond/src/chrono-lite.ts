type KnownValues = Partial<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

type ParseResult = {
  text: string;
  start: {
    knownValues: KnownValues;
    date(): Date;
  };
};

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

function applyKnownTime(base: Date, knownValues: KnownValues): void {
  if (typeof knownValues.hour === "number") {
    base.setUTCHours(knownValues.hour);
  }
  if (typeof knownValues.minute === "number") {
    base.setUTCMinutes(knownValues.minute);
  }
  if (typeof knownValues.second === "number") {
    base.setUTCSeconds(knownValues.second);
  }
  if (typeof knownValues.hour === "number" || typeof knownValues.minute === "number" || typeof knownValues.second === "number") {
    base.setUTCMilliseconds(0);
  }
}

function parseTimeToken(text: string): { matchedText: string; knownValues: KnownValues } | null {
  const special = text.match(/\b(noon|midnight)\b/i);
  if (special) {
    return {
      matchedText: special[0],
      knownValues: special[1].toLowerCase() === "noon" ? { hour: 12, minute: 0, second: 0 } : { hour: 0, minute: 0, second: 0 },
    };
  }

  const match = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) {
    return null;
  }

  const hourRaw = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const second = match[3] ? Number(match[3]) : 0;
  const meridiem = match[4]?.toLowerCase();

  if (!Number.isInteger(hourRaw) || !Number.isInteger(minute) || !Number.isInteger(second)) {
    return null;
  }

  if (minute > 59 || second > 59) {
    return null;
  }

  let hour = hourRaw;
  if (meridiem) {
    if (hourRaw < 1 || hourRaw > 12) {
      return null;
    }
    hour = hourRaw % 12;
    if (meridiem === "pm") {
      hour += 12;
    }
  } else if (hourRaw > 23) {
    return null;
  }

  return {
    matchedText: match[0],
    knownValues: {
      hour,
      minute,
      second,
    },
  };
}

function parseRelative(text: string, refDate: Date): ParseResult | null {
  const match = text.match(/\bin\s+(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days|week|weeks)\b/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const date = cloneDate(refDate);
  const multipliers: Record<string, number> = {
    second: 1000,
    seconds: 1000,
    minute: 60_000,
    minutes: 60_000,
    hour: 3_600_000,
    hours: 3_600_000,
    day: 86_400_000,
    days: 86_400_000,
    week: 604_800_000,
    weeks: 604_800_000,
  };
  date.setTime(date.getTime() + amount * multipliers[unit]);

  const knownValues: KnownValues = {};
  if (unit.startsWith("second")) {
    knownValues.second = date.getUTCSeconds();
  }
  if (!unit.startsWith("day") && !unit.startsWith("week")) {
    knownValues.hour = date.getUTCHours();
    knownValues.minute = date.getUTCMinutes();
  }

  return {
    text: match[0],
    start: {
      knownValues,
      date: () => cloneDate(date),
    },
  };
}

function nextWeekday(refDate: Date, weekday: number): Date {
  const date = cloneDate(refDate);
  const current = date.getUTCDay();
  let delta = (weekday - current + 7) % 7;
  if (delta === 0) {
    delta = 7;
  }
  date.setUTCDate(date.getUTCDate() + delta);
  return date;
}

function parseAbsolute(text: string, refDate: Date): ParseResult | null {
  const lower = text.toLowerCase();
  const timeToken = parseTimeToken(text);
  const timeOffset = timeToken ? text.toLowerCase().indexOf(timeToken.matchedText.toLowerCase()) : -1;

  const bases: Array<{ matchedText: string; date: Date; knownValues: KnownValues }> = [];

  if (/\btomorrow\b/i.test(text)) {
    const date = cloneDate(refDate);
    date.setUTCDate(date.getUTCDate() + 1);
    bases.push({ matchedText: "tomorrow", date, knownValues: {} });
  }

  if (/\btoday\b/i.test(text)) {
    bases.push({ matchedText: "today", date: cloneDate(refDate), knownValues: {} });
  }

  for (const [name, index] of Object.entries(WEEKDAY_INDEX)) {
    if (new RegExp(`\\b${name}\\b`, "i").test(text)) {
      bases.push({ matchedText: name, date: nextWeekday(refDate, index), knownValues: {} });
      break;
    }
  }

  if (!bases.length && timeToken) {
    const date = cloneDate(refDate);
    applyKnownTime(date, timeToken.knownValues);
    if (date.getTime() <= refDate.getTime()) {
      date.setUTCDate(date.getUTCDate() + 1);
    }
    return {
      text: timeToken.matchedText,
      start: {
        knownValues: timeToken.knownValues,
        date: () => cloneDate(date),
      },
    };
  }

  if (!bases.length) {
    return null;
  }

  const base = bases[0];
  const date = cloneDate(base.date);
  if (timeToken) {
    applyKnownTime(date, timeToken.knownValues);
  }

  const matchedText =
    timeToken && timeOffset >= 0
      ? lower.indexOf(base.matchedText.toLowerCase()) <= timeOffset
        ? text.slice(text.toLowerCase().indexOf(base.matchedText.toLowerCase()), timeOffset + timeToken.matchedText.length)
        : `${base.matchedText} ${timeToken.matchedText}`
      : base.matchedText;

  return {
    text: matchedText,
    start: {
      knownValues: {
        ...base.knownValues,
        ...(timeToken?.knownValues ?? {}),
      },
      date: () => cloneDate(date),
    },
  };
}

function parse(text: string, refDate: Date, _options?: { forwardDate?: boolean }): ParseResult[] {
  const relative = parseRelative(text, refDate);
  if (relative) {
    return [relative];
  }

  const absolute = parseAbsolute(text, refDate);
  if (absolute) {
    return [absolute];
  }

  return [];
}

export default { parse };
export type { ParseResult };
