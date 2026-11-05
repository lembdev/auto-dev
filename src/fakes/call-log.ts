export type Call = {
  method: string;
  args: unknown[];
};

// Recording helper shared by every fake: tests assert on `calls`.
export class CallLog {
  readonly calls: Call[] = [];

  record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  of(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  clear(): void {
    this.calls.length = 0;
  }
}
