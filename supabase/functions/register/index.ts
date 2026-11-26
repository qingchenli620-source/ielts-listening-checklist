// 注册接口。部署时 verify_jwt 必须为 false（见 supabase/config.toml）。
// 公开注册在 Auth 设置里保持关闭。这个函数用自动注入的服务端密钥创建用户。
// 浏览器里的 anon / publishable key 不能绕过邀请码。
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "只接受 POST" }, 405);

  let body: { email?: string; password?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "请求格式不对" }, 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const code = normalizeCode(String(body.code || ""));

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "邮箱格式不对" }, 400);
  if (password.length < 6 || password.length > 72) return json({ error: "密码至少 6 位" }, 400);
  if (!/^[A-F0-9]{12}$/.test(code)) return json({ error: "邀请码不正确" }, 400);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY");
  if (!url || !serviceKey) return json({ error: "注册服务还没配置好" }, 500);

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const consumed = await admin
    .from("invite_codes")
    .update({ used_at: new Date().toISOString(), used_email: email })
    .eq("code", code)
    .is("used_at", null)
    .select("code");

  if (consumed.error) {
    console.error(consumed.error.message);
    return json({ error: "注册暂时失败，请稍后再试" }, 500);
  }
  if (!consumed.data || consumed.data.length === 0) {
    return json({ error: "邀请码无效或已经使用过" }, 400);
  }

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (created.error || !created.data.user) {
    await admin
      .from("invite_codes")
      .update({ used_at: null, used_email: null })
      .eq("code", code)
      .is("used_by", null)
      .eq("used_email", email);
    const message = created.error?.message || "";
    if (/already been registered|already registered|email_exists|user already/i.test(message)) {
      return json({ error: "这个邮箱已经注册，请直接登录" }, 400);
    }
    if (/password/i.test(message)) {
      return json({ error: "密码不符合要求，请换一个至少 6 位的密码" }, 400);
    }
    console.error(message || "createUser failed");
    return json({ error: "注册没有成功，邀请码没有被用掉，请稍后再试" }, 500);
  }

  const linked = await admin
    .from("invite_codes")
    .update({ used_by: created.data.user.id })
    .eq("code", code);
  if (linked.error) console.error(linked.error.message);

  return json({ ok: true });
});
