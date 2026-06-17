/** Serializes proxy/llama start, stop, and reload operations. */
let chain: Promise<void> = Promise.resolve();

export const withLifecycleLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
};
