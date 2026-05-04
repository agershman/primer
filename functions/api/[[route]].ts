interface Env {
	PRIMER_API: Fetcher;
}

export const onRequest: PagesFunction<Env> = async (context) => {
	const url = new URL(context.request.url);

	return context.env.PRIMER_API.fetch(
		new Request(`https://primer-api${url.pathname}${url.search}`, {
			method: context.request.method,
			headers: context.request.headers,
			body: context.request.method !== "GET" ? context.request.body : undefined,
		}),
	);
};
