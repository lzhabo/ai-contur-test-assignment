import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

/** Host-owned handles: candidate code cannot replace the verifier's state or intrinsics. */
export class JsonBridge {
  private readonly handles: QuickJSHandle[] = [];
  private readonly descriptor: QuickJSHandle;
  private readonly prototype: QuickJSHandle;
  private readonly isArray: QuickJSHandle;
  private readonly kind: QuickJSHandle;
  private readonly objectPrototype: QuickJSHandle;
  private readonly arrayPrototype: QuickJSHandle;

  private readonly context: QuickJSContext;
  private readonly deadline: number;

  /** Сохраняет исходные функции QuickJS до загрузки кода кандидата, чтобы тот не мог подменить проверку. */
  constructor(context: QuickJSContext, deadline: number) {
    this.context = context;
    this.deadline = deadline;
    const capture =
      /* Вычисляет доверенное выражение и удерживает его handle до закрытия моста. */ (
        source: string,
      ) => {
        const handle = context.unwrapResult(context.evalCode(source));
        this.handles.push(handle);
        return handle;
      };
    // Capture before loading the candidate. No references are installed in its global scope.
    this.descriptor = capture("Object.getOwnPropertyDescriptor");
    this.prototype = capture("Object.getPrototypeOf");
    this.isArray = capture("Array.isArray");
    this.kind = capture("(value) => typeof value");
    this.objectPrototype = capture("Object.prototype");
    this.arrayPrototype = capture("Array.prototype");
  }

  /** Освобождает удерживаемые ссылки на функции и прототипы QuickJS. */
  dispose(): void {
    for (const handle of this.handles) handle.dispose();
  }

  /** Читает значение из QuickJS как ограниченное JSON-дерево без запуска getter-функций. */
  read(root: QuickJSHandle): unknown {
    const ctx = this.context;
    const ancestors: QuickJSHandle[] = [];
    let nodes = 0;
    let bytes = 0;
    const account =
      /* Учитывает объём результата и останавливает чтение по лимиту памяти или времени. */ (
        size: number,
      ) => {
        bytes += size;
        if (++nodes > 10_000 || bytes > 64 * 1024)
          throw new Error("JSON result exceeds size limit");
        if (Date.now() >= this.deadline) throw new Error("Check deadline interrupted");
      };
    const call = /* Вызывает сохранённую доверенную функцию QuickJS и извлекает её результат. */ (
      fn: QuickJSHandle,
      ...args: QuickJSHandle[]
    ) => ctx.unwrapResult(ctx.callFunction(fn, ctx.undefined, args));
    const readDataProperty =
      /* Читает собственное свойство только с дескриптором данных, отклоняя getter и setter. */ (
        object: QuickJSHandle,
        key: QuickJSHandle,
        depth: number,
      ): unknown => {
        const descriptor = call(this.descriptor, object, key);
        try {
          const names = ctx.unwrapResult(ctx.getOwnPropertyNames(descriptor));
          try {
            if (
              !names.some(
                /* Проверяет наличие поля value у дескриптора свойства. */ (name) =>
                  ctx.getString(name) === "value",
              )
            )
              throw new Error("Accessors are not JSON data");
          } finally {
            names.dispose();
          }
          const value = ctx.getProp(descriptor, "value");
          try {
            return visit(value, depth);
          } finally {
            value.dispose();
          }
        } finally {
          descriptor.dispose();
        }
      };
    const visit = /* Обходит JSON-значение, проверяя тип, глубину, циклы и безопасные свойства. */ (
      value: QuickJSHandle,
      depth: number,
    ): unknown => {
      account(1);
      if (depth > 64) throw new Error("JSON nesting limit exceeded");
      if (ctx.eq(value, ctx.null)) return null;
      const kindHandle = call(this.kind, value);
      let kind: string;
      try {
        kind = ctx.getString(kindHandle);
      } finally {
        kindHandle.dispose();
      }
      if (kind === "boolean") return ctx.eq(value, ctx.true);
      if (kind === "number") {
        const number = ctx.getNumber(value);
        if (!Number.isFinite(number)) throw new Error("Non-finite number is not JSON data");
        return number;
      }
      if (kind === "string") {
        const text = ctx.getString(value);
        account(Buffer.byteLength(text));
        return text;
      }
      if (kind !== "object") throw new Error(`${kind} is not JSON data`);
      if (
        ancestors.some(
          /* Обнаруживает повтор предка в дереве результата и тем самым цикл. */ (parent) =>
            ctx.eq(parent, value),
        )
      )
        throw new Error("Cyclic output is not JSON data");
      const arrayHandle = call(this.isArray, value);
      const array = ctx.eq(arrayHandle, ctx.true);
      arrayHandle.dispose();
      const prototype = call(this.prototype, value);
      try {
        const allowed = array
          ? ctx.eq(prototype, this.arrayPrototype)
          : ctx.eq(prototype, this.objectPrototype) || ctx.eq(prototype, ctx.null);
        if (!allowed) throw new Error("Only plain objects and arrays are JSON data");
      } finally {
        prototype.dispose();
      }
      const keys = ctx.unwrapResult(
        ctx.getOwnPropertyNames(value, { strings: true, numbersAsStrings: true, symbols: true }),
      );
      ancestors.push(value);
      try {
        if (keys.length > 10_001) throw new Error("JSON result exceeds property limit");
        const output: unknown[] | Record<string, unknown> = array ? [] : {};
        let arrayLength = 0;
        if (array) {
          const length = ctx.getProp(value, "length");
          try {
            arrayLength = ctx.getNumber(length);
          } finally {
            length.dispose();
          }
          if (
            !Number.isSafeInteger(arrayLength) ||
            arrayLength < 0 ||
            arrayLength > 10_000 ||
            keys.length !== arrayLength + 1
          )
            throw new Error("Sparse or decorated arrays are not JSON data");
        }
        for (const key of keys) {
          if (ctx.typeof(key) !== "string") throw new Error("Symbol properties are not JSON data");
          const name = ctx.getString(key);
          if (array && name === "length") continue;
          if (array && (!/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= arrayLength))
            throw new Error("Decorated arrays are not JSON data");
          account(Buffer.byteLength(name));
          // Define own properties, including __proto__, without invoking any host setters.
          Object.defineProperty(output, name, {
            value: readDataProperty(value, key, depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return output;
      } finally {
        ancestors.pop();
        keys.dispose();
      }
    };
    const output = visit(root, 0);
    if (Buffer.byteLength(JSON.stringify(output)) > 64 * 1024)
      throw new Error("JSON result exceeds size limit");
    return output;
  }
}
