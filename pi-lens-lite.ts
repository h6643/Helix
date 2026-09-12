export default async function piLensLite(pi: any) {
  const lens = await import(
    new URL("../npm/node_modules/pi-lens/dist/index.js", import.meta.url).href
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
          return Array.isArray(result) ? result : { ...result, skillPaths: [] };
        });
      };
    },
  });

  return lens.default(wrappedPi);
}
