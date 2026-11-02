import type { DescService } from '@bufbuild/protobuf';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';

export function internalClient<S extends DescService>(service: S, baseUrl: string, token: string) {
  return createClient(
    service,
    createConnectTransport({
      baseUrl,
      httpVersion: '1.1',
      interceptors: [
        (next) => (req) => {
          req.header.set('authorization', `Bearer ${token}`);
          return next(req);
        },
      ],
    }),
  );
}
