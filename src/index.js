export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// フロントエンド（別のポート）からのアクセスを許可する設定
		const corsHeaders = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, PUT, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		};

		// ブラウザが本番リクエストの前に送る確認リクエストへの応答
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		// GET /companies : 企業一覧の取得
		if (request.method === "GET" && url.pathname === "/companies") {
			const { results } = await env.DB.prepare(
				"SELECT * FROM companies ORDER BY created_at DESC"
			).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// POST /companies : 企業の新規登録
		if (request.method === "POST" && url.pathname === "/companies") {
			const body = await request.json();
			const { company_name, job_url, job_text, interest_level } = body;

			// 開発初期のため user_id は固定（ダミー）
			const userId = "dummy_user_123";

			await env.DB.prepare(
				`INSERT INTO companies (user_id, company_name, job_url, job_text, interest_level)
				VALUES (?, ?, ?, ?, ?)`
			).bind(userId, company_name, job_url || null, job_text || null, interest_level || 3).run();

			return Response.json({ message: "Company added successfully!" }, { status: 201, headers: corsHeaders });
		}

		// PATCH /companies/:id : 志望度・ステータスなどの更新
		if (request.method === "PATCH" && url.pathname.startsWith("/companies/")) {
			const id = url.pathname.split("/")[2];
			const body = await request.json();

			const fields = [];
			const values = [];

			if (body.interest_level !== undefined) {
				fields.push("interest_level = ?");
				values.push(body.interest_level);
			}
			if (body.status !== undefined) {
				fields.push("status = ?");
				values.push(body.status);
			}

			values.push(id);

			await env.DB.prepare(
				`UPDATE companies SET ${fields.join(", ")} WHERE id = ?`
			).bind(...values).run();

			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// GET /impressions?company_id=1 : 特定の企業のいいな・気になるを取得
		if (request.method === "GET" && url.pathname === "/impressions") {
			const companyId = url.searchParams.get("company_id");
			const { results } = await env.DB.prepare(
				"SELECT * FROM impressions WHERE company_id = ? ORDER BY created_at DESC"
			).bind(companyId).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// POST /impressions : いいな・気になるを追加
		if (request.method === "POST" && url.pathname === "/impressions") {
			const body = await request.json();
			const { company_id, type, content } = body;

			await env.DB.prepare(
				"INSERT INTO impressions (company_id, type, content) VALUES (?, ?, ?)"
			).bind(company_id, type, content).run();

			return Response.json({ success: true }, { status: 201, headers: corsHeaders });
		}

		// DELETE /impressions/:id : いいな・気になるを削除
		if (request.method === "DELETE" && url.pathname.startsWith("/impressions/")) {
			const id = url.pathname.split("/")[2];
			await env.DB.prepare("DELETE FROM impressions WHERE id = ?").bind(id).run();
			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// GET /honne?company_id=1 : 本音を取得
		if (request.method === "GET" && url.pathname === "/honne") {
			const companyId = url.searchParams.get("company_id");
			const { results } = await env.DB.prepare(
				"SELECT * FROM honne WHERE company_id = ?"
			).bind(companyId).all();
			return Response.json(results[0] || null, { headers: corsHeaders });
		}

		// PUT /honne : 本音を保存（新規作成 or 上書き更新）
		if (request.method === "PUT" && url.pathname === "/honne") {
			const body = await request.json();
			const { company_id, content } = body;

			await env.DB.prepare(
				`INSERT INTO honne (company_id, content) VALUES (?, ?)
    ON CONFLICT(company_id) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP`
			).bind(company_id, content).run();

			return Response.json({ success: true }, { headers: corsHeaders });
		}

		// GET /memos?company_id=1 : 特定の企業のメモを取得
		if (request.method === "GET" && url.pathname === "/memos") {
			const companyId = url.searchParams.get("company_id");
			const { results } = await env.DB.prepare(
				"SELECT * FROM memos WHERE company_id = ? ORDER BY created_at DESC"
			).bind(companyId).all();
			return Response.json(results, { headers: corsHeaders });
		}

		// POST /memos : メモを追加
		if (request.method === "POST" && url.pathname === "/memos") {
			const body = await request.json();
			const { company_id, content } = body;

			await env.DB.prepare(
				"INSERT INTO memos (company_id, content) VALUES (?, ?)"
			).bind(company_id, content).run();

			return Response.json({ success: true }, { status: 201, headers: corsHeaders });
		}

		// DELETE /memos/:id : メモを削除
		if (request.method === "DELETE" && url.pathname.startsWith("/memos/")) {
			const id = url.pathname.split("/")[2];
			await env.DB.prepare("DELETE FROM memos WHERE id = ?").bind(id).run();
			return Response.json({ success: true }, { headers: corsHeaders });
		}

		return new Response("Mebae API is running!", { status: 200, headers: corsHeaders });
	},
};