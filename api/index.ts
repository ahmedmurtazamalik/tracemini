let handlerPromise: Promise<any> | undefined;

export default async function handler(request: any, response: any) {
  const serverless = await (handlerPromise ??= import('../apps/server/src/vercel.js').then(module => module.default));
  return serverless(request, response);
}
