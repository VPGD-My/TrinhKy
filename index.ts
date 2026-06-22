import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const NOTIFY_MAILBOX = Deno.env.get("NOTIFY_MAILBOX");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
console.log("INDEX JS LOADED");
// Hàm build Adaptive Card JSON cho Teams
function buildAdaptiveCard(
  ten_ho_so: string,
  nguoi_nhan: string,
  phong_ban?: string,
  ngay_gui?: string
) {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body: [
      {
        type: "Container",
        style: "good",
        bleed: true,
        items: [
          {
            type: "TextBlock",
            text: "✅ Hồ sơ hoàn thành",
            weight: "Bolder",
            size: "Medium",
            wrap: true,
          },
          {
            type: "FactSet",
            facts: [
              { title: "📑 Tên hồ sơ", value: ten_ho_so },
              { title: "👤 Người gửi", value: nguoi_nhan },
              { title: "🏬 Phòng ban", value: phong_ban || "—" },
              { title: "🗓️ Ngày gửi", value: ngay_gui || "—" },
            ],
          },
        ],
      },
    ],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email, ten_ho_so, nguoi_nhan, phong_ban, ngay_gui } = await req.json();

    if (!email || !ten_ho_so) {
      return new Response(
        JSON.stringify({ error: "Thiếu email hoặc tên hồ sơ" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const card = buildAdaptiveCard(ten_ho_so, nguoi_nhan, phong_ban, ngay_gui);

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "onboarding@resend.dev",
        to: [NOTIFY_MAILBOX],
        subject: "[TRINHKY-NOTIFY]",
        text: JSON.stringify({
          to: email,
          card: JSON.stringify(card),  // gửi nguyên Adaptive Card JSON, thay vì message dạng text
        }),
      }),
    });

    const result = await resendResponse.json();

    if (!resendResponse.ok) {
      console.error("Lỗi gửi email:", result);
      return new Response(JSON.stringify({ error: result }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, result }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
