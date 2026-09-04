export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// フロントエンド（別のポート）からのアクセスを許可する設定
		const corsHeaders = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
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

		// PATCH /companies/:id : 志望度などの更新
		if (request.method === "PATCH" && url.pathname.startsWith("/companies/")) {
			const id = url.pathname.split("/")[2]; // URLの末尾から企業のidを取り出す
			const body = await request.json();

			await env.DB.prepare(
				"UPDATE companies SET interest_level = ? WHERE id = ?"
			).bind(body.interest_level, id).run();

			return Response.json({ success: true }, { headers: corsHeaders });
		}

		return new Response("Mebae API is running!", { status: 200, headers: corsHeaders });
	},
};