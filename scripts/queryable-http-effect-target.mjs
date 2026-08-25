export function createQueryableHttpEffectTarget(baseUrl, targetId = 'iteration-4-http-target') {
  return {
    targetId,
    lookup: async (idempotencyKey) => {
      const response = await fetch(`${baseUrl}/effects/${encodeURIComponent(idempotencyKey)}`);
      const evidenceRefs = [`http:lookup:${String(response.status)}:${idempotencyKey}`];
      if (response.status === 200) {
        return { status: 'found', receipt: await response.json(), evidenceRefs };
      }
      if (response.status === 404) return { status: 'absent', evidenceRefs };
      if (response.status === 409) {
        return { status: 'ambiguous', evidenceRefs, detail: 'target reported competing records' };
      }
      return { status: 'unknown', evidenceRefs, detail: 'target lookup unavailable' };
    },
    dispatch: async ({ idempotencyKey, payload }) => {
      const response = await fetch(`${baseUrl}/effects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      const evidenceRefs = [`http:dispatch:${String(response.status)}:${idempotencyKey}`];
      if (response.status === 200 || response.status === 201) {
        return { status: 'accepted', receipt: await response.json(), evidenceRefs };
      }
      if (response.status >= 500) {
        return { status: 'unknown', evidenceRefs, detail: 'target dispatch unavailable' };
      }
      return { status: 'rejected', evidenceRefs, detail: 'target rejected dispatch' };
    },
  };
}
