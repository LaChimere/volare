export interface IStreamOptions {
  onFirstPull?: () => void;
  onCancel?: () => Promise<void>;
  onComplete?: () => void;
  onError?: (error: unknown) => void;
}

export function asyncIterableToStream(
  iterable: AsyncIterable<Uint8Array>,
  options: IStreamOptions = {},
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  let firstPull = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (firstPull) {
        firstPull = false;
        options.onFirstPull?.();
      }
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          options.onComplete?.();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        options.onError?.(error);
        throw error;
      }
    },
    async cancel() {
      let cancelError: unknown;
      try {
        await options.onCancel?.();
      } catch (error) {
        cancelError = error;
      }
      try {
        await iterator.return?.();
      } catch (returnError) {
        if (cancelError) {
          const cleanupError = new AggregateError(
            [cancelError, returnError],
            'Stream cancellation cleanup failed',
          );
          options.onError?.(cleanupError);
          throw cleanupError;
        }
        options.onError?.(returnError);
        throw returnError;
      }
      if (cancelError) {
        options.onError?.(cancelError);
        throw cancelError;
      }
      options.onComplete?.();
    },
  });
}
