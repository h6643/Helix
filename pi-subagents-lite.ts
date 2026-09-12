export default async function piSubagentsLite(pi: any) {
  const subagents = await import(
    new URL("../npm/node_modules/pi-subagents/index.ts", import.meta.url).href
  );

  const wrappedPi = new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== "on") {
        return Reflect.get(target, property, receiver);
      }

      return (event: string, handler: (...args: any[]) => any) => {
        if (event !== "resources_discover") {
          return Reflect.get(target, property, receiver)(event, handler);
        }

        return target.on(event, async (...args: any[]) => {
          const result = await handler(...args);
          return Array.isArray(result)
            ? result
            : { ...result, skillPaths: [] };
        });
      };
    },
  });

  return subagents.default(wrappedPi);
}
