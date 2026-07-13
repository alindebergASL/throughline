import { context, propagation, ROOT_CONTEXT, trace, type Span } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { afterEach, describe, expect, it } from "vitest";

type TraceCarrier = { traceparent: string; tracestate?: string };
type TraceAttributes = Readonly<Record<string, unknown>>;
type WithPropagatedSpan = <T>(
  options: {
    name: string;
    parentCarrier?: Partial<TraceCarrier>;
    fallbackCarrier?: TraceCarrier;
    attributes?: TraceAttributes;
  },
  callback: (result: { span: Span; carrier: TraceCarrier }) => T | Promise<T>
) => Promise<T>;

const parentCarrier = {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  tracestate: "throughline=task8"
} as const;
const fallbackCarrier = {
  traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"
} as const;

async function loadHelper(): Promise<WithPropagatedSpan> {
  const module = (await import("./index.js")) as { withPropagatedSpan?: WithPropagatedSpan };
  if (typeof module.withPropagatedSpan !== "function") {
    throw new Error("Task 8 requires observability.withPropagatedSpan");
  }
  return module.withPropagatedSpan;
}

afterEach(() => {
  propagation.disable();
  trace.disable();
  context.disable();
});

describe("withPropagatedSpan W3C contract", () => {
  it("uses the real W3C propagator to extract and inject traceparent and tracestate", () => {
    const propagator = new W3CTraceContextPropagator();
    const getter = {
      keys: (carrier: Partial<TraceCarrier>) => Object.keys(carrier),
      get: (carrier: Partial<TraceCarrier>, key: string) => carrier[key as keyof TraceCarrier]
    };
    const setter = {
      set: (carrier: Partial<TraceCarrier>, key: string, value: string) => {
        carrier[key as keyof TraceCarrier] = value;
      }
    };

    const extracted = propagator.extract(ROOT_CONTEXT, parentCarrier, getter);
    expect(trace.getSpanContext(extracted)).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      isRemote: true
    });
    const reinjected: Partial<TraceCarrier> = {};
    propagator.inject(extracted, reinjected, setter);
    expect(reinjected).toEqual(parentCarrier);
  });

  it("uses a safe root fallback for an invalid incoming carrier", async () => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    const withPropagatedSpan = await loadHelper();

    await withPropagatedSpan(
      {
        name: "task8.invalid-parent",
        parentCarrier: { traceparent: "raw-user-trace" },
        fallbackCarrier
      },
      ({ carrier }) => {
        expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
        expect(carrier.traceparent).not.toContain("raw-user-trace");
      }
    );
  });

  it("preserves a valid incoming carrier, or the supplied fallback, without an SDK provider", async () => {
    const withPropagatedSpan = await loadHelper();
    const observed: string[] = [];

    await withPropagatedSpan({ name: "task8.no-provider", parentCarrier }, ({ carrier }) => {
      observed.push(carrier.traceparent);
    });
    await withPropagatedSpan(
      { name: "task8.no-provider-fallback", parentCarrier: {}, fallbackCarrier },
      ({ carrier }) => {
        observed.push(carrier.traceparent);
      }
    );

    expect(observed).toEqual([parentCarrier.traceparent, fallbackCarrier.traceparent]);
  });

  it("filters absent allowlisted values and rejects non-allowlisted attribute names at runtime", async () => {
    const withPropagatedSpan = await loadHelper();
    let callbackRan = false;

    await expect(
      withPropagatedSpan(
        {
          name: "task8.attribute-rejection",
          fallbackCarrier,
          attributes: {
            "throughline.request.id": undefined,
            "throughline.tenant.id": "tenant-safe",
            "security.context": "must-never-reach-a-span",
            credential: "must-never-reach-a-span"
          }
        },
        () => {
          callbackRan = true;
        }
      )
    ).rejects.toThrow(/attribute|allowlist/i);
    expect(callbackRan).toBe(false);
  });
});
