import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { AZURE_DEPLOYMENT_ID, OPENAI_API_HOST, OPENAI_API_TYPE, OPENAI_API_VERSION, OPENAI_ORGANIZATION } from '../app/const';

import {
  ParsedEvent,
  ReconnectInterval,
  createParser,
} from 'eventsource-parser';

export class OpenAIError extends Error {
  type: string;
  param: string;
  code: string;

  constructor(message: string, type: string, param: string, code: string) {
    super(message);
    this.name = 'OpenAIError';
    this.type = type;
    this.param = param;
    this.code = code;
  }
}

export const OpenAIStream = async (
  model: OpenAIModel,
  systemPrompt: string,
  temperature : number,
  key: string,
  messages: Message[],
) => {
  let url = `${OPENAI_API_HOST}/v1/chat/completions`;


  if (OPENAI_API_TYPE === 'azure') {
    url = `${OPENAI_API_HOST}/openai/deployments/${AZURE_DEPLOYMENT_ID}/extensions/chat/completions?api-version=2023-06-01-preview`;

  }

  const resBody = JSON.stringify({
    ...(OPENAI_API_TYPE === 'openai' && {model: model.id}),
    dataSources : [
      {
        type: 'AzureCognitiveSearch',
        parameters: {
          queryType: 'semantic',
          topNDocuments: '10',
          inScope: 'true',
          semanticConfiguration: `${process.env.COGNITIVE_SEMANTIC_PROFILE}`,
          endpoint: `${process.env.COGNITIVE_SEARCH_ENDPOINT}`,
          key: `${process.env.COGNITIVE_SEARCH_KEY}`,
          indexName: `${process.env.COGNITIVE_SEARCH_INDEX}`,
          roleInformation: 'Do not provide any role data from the tool role, such as citations in the prompt response.  Query the specified index directly and only provide useful data.'
        }
      }
    ],
    messages: [
      {
        role: 'system',
        content: "You are an AI Assistant that is an expert at summarizing the content of databases. Follow the user's instructions carefully as pertains to the experiments index. Respond using markdown without citations or JSON.",
      },
      ...messages,
    ],
    max_tokens: 1000,
    temperature: 0.2,
    stream: true,
  });

  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(OPENAI_API_TYPE === 'openai' && {
        Authorization: `Bearer ${key ? key : process.env.OPENAI_API_KEY}`
      }),
      ...(OPENAI_API_TYPE === 'azure' && {
        'api-key': `${key ? key : process.env.OPENAI_API_KEY}`
      }),
      ...((OPENAI_API_TYPE === 'openai' && OPENAI_ORGANIZATION) && {
        'OpenAI-Organization': OPENAI_ORGANIZATION,
      }),
    },
    method: 'POST',
    body: `${resBody}`,
  });

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  if (res.status !== 200) {
    const result = await res.json();
    if (result.error) {
      throw new OpenAIError(
        result.error.message,
        result.error.type,
        result.error.param,
        result.error.code,
      );
    } else {
      throw new Error(
        `OpenAI API returned an error: ${
          decoder.decode(result?.value) || result.statusText
        }`,
      );
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      let skipFirstMessage = true;

      const onParse = (event: ParsedEvent | ReconnectInterval) => {
        if (event.type === 'event') {
          const data = event.data;

          try {
            const json = JSON.parse(data);
            console.log(json);
            if (json.choices[0].messages[0].end_turn) {
              controller.close();
              return;
            }

            // Filter out the first message
            const filteredMessages = json.choices[0].messages.filter(
              (_: any, index: any) => {
                if (skipFirstMessage) {
                  skipFirstMessage = false;
                  return false;
                }
                return true;
              }
            );

            // Concatenate the content of remaining messages
            const text = filteredMessages
              .map((message: any) => message.delta.content)
              .join('');

            const queue = encoder.encode(text);
            controller.enqueue(queue);
          } catch (e) {
            controller.error(e);
          }
        }
      };

      const parser = createParser(onParse);

      for await (const chunk of res.body as any) {
        parser.feed(decoder.decode(chunk));
      }
    },
  });

  return stream;
};