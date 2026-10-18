const SYSTEM_PROMPT = `
Ты голосовой помощник внутри навыка Яндекс Алисы.

Правила:
- Отвечай по-русски.
- Отвечай кратко: обычно 2–5 предложений.
- Используй естественную разговорную речь.
- Не используй Markdown, таблицы и ссылки.
- Не утверждай, что управляешь функциями Яндекс Станции.
- Если вопрос неоднозначен, задай один короткий уточняющий вопрос.
- Ответ будет произнесён вслух.
`.trim();

function aliceResponse(text, history = [], endSession = false) {
  return {
    response: {
      text,
      tts: text,
      end_session: endSession,
    },
    session_state: {
      history,
    },
    version: "1.0",
  };
}

function cleanForSpeech(input) {
  let text = String(input ?? "");

  text = text
    .replace(/```[\s\S]*?```/g, "Код опущен в голосовом ответе.")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // У response.text Алисы ограничение 1024 символа.
  if (text.length > 950) {
    text = text.slice(0, 947);
    const lastSpace = text.lastIndexOf(" ");

    if (lastSpace > 700) {
      text = text.slice(0, lastSpace);
    }

    text += "…";
  }

  return text;
}

async function askGemini(command, history) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model =
    process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

  if (!apiKey) {
    throw new Error("Переменная GEMINI_API_KEY не настроена");
  }

  const contents = [];

  // Передаём несколько последних реплик для поддержания контекста.
  for (const message of history.slice(-6)) {
    if (
      !["user", "model"].includes(message?.role) ||
      !message?.text
    ) {
      continue;
    }

    contents.push({
      role: message.role,
      parts: [{ text: String(message.text) }],
    });
  }

  contents.push({
    role: "user",
    parts: [{ text: command }],
  });

  const payload = {
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents,
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 220,
    },
  };

  // Алиса ждёт весь webhook не более 4,5 секунды.
  // Оставляем запас на Vercel и передачу ответа Яндексу.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2800);

  try {
    const result = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );

    if (!result.ok) {
      const errorText = await result.text();
      console.error(
        "Gemini API error:",
        result.status,
        errorText.slice(0, 500),
      );

      throw new Error(`Gemini API returned ${result.status}`);
    }

    const data = await result.json();
    const parts =
      data?.candidates?.[0]?.content?.parts ?? [];

    const answer = parts
      .map((part) => part?.text ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();

    if (!answer) {
      throw new Error("Gemini вернул пустой ответ");
    }

    return cleanForSpeech(answer);
  } finally {
    clearTimeout(timeoutId);
  }
}

export default async function handler(request, response) {
  // Позволяет открыть адрес функции в браузере для проверки.
  if (request.method === "GET") {
    return response.status(200).json({
      status: "ok",
      service: "alice-gemini-webhook",
    });
  }

  if (request.method !== "POST") {
    return response.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const body =
      typeof request.body === "string"
        ? JSON.parse(request.body)
        : request.body ?? {};

    const command = String(
      body?.request?.command ?? "",
    ).trim();

    const isNewSession =
      body?.session?.new === true;

    const history = Array.isArray(
      body?.state?.session?.history,
    )
      ? body.state.session.history
      : [];

    if (isNewSession && !command) {
      return response.status(200).json(
        aliceResponse(
          "Привет! Я готова. Задайте мне вопрос.",
        ),
      );
    }

    if (!command) {
      return response.status(200).json(
        aliceResponse(
          "Я не расслышала вопрос. Повторите, пожалуйста.",
          history,
        ),
      );
    }

    const normalized = command.toLowerCase();

    if (
      normalized === "помощь" ||
      normalized === "что ты умеешь"
    ) {
      return response.status(200).json(
        aliceResponse(
          "Я могу отвечать на вопросы, объяснять сложные темы, придумывать идеи и поддерживать разговор.",
          history,
        ),
      );
    }

    try {
      const answer = await askGemini(command, history);

      const newHistory = [
        ...history.slice(-4),
        {
          role: "user",
          text: command.slice(0, 500),
        },
        {
          role: "model",
          text: answer.slice(0, 950),
        },
      ];

      return response
        .status(200)
        .json(aliceResponse(answer, newHistory));
    } catch (error) {
      if (
        error?.name === "AbortError" ||
        error?.name === "TimeoutError"
      ) {
        console.warn("Gemini request timed out");

        return response.status(200).json(
          aliceResponse(
            "Ответ занял слишком много времени. Попробуйте задать вопрос ещё раз.",
            history,
          ),
        );
      }

      console.error("Gemini request failed:", error);

      return response.status(200).json(
        aliceResponse(
          "Сейчас мне не удалось обратиться к нейросети. Попробуйте немного позже.",
          history,
        ),
      );
    }
  } catch (error) {
    console.error("Webhook error:", error);

    // Яндексу лучше вернуть корректный ответ, даже если запрос оказался ошибочным.
    return response.status(200).json(
      aliceResponse(
        "Произошла техническая ошибка. Попробуйте ещё раз.",
      ),
    );
  }
}