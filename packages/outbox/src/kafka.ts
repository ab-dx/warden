import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { OutboxMessage, Publisher } from './relay.js';

type Producer = ReturnType<InstanceType<typeof KafkaJS.Kafka>['producer']>;

export class KafkaPublisher implements Publisher {
  private constructor(private readonly producer: Producer) {}

  static async connect(brokers: string[], clientId: string): Promise<KafkaPublisher> {
    const kafka = new KafkaJS.Kafka({ kafkaJS: { brokers, clientId } });
    // idempotent producer: broker drops retries it has already written
    const producer = kafka.producer({ kafkaJS: { idempotent: true, acks: -1 } });
    await producer.connect();
    return new KafkaPublisher(producer);
  }

  async publish(messages: OutboxMessage[]): Promise<void> {
    const byTopic = new Map<string, OutboxMessage[]>();
    for (const m of messages) byTopic.set(m.topic, [...(byTopic.get(m.topic) ?? []), m]);
    await this.producer.sendBatch({
      topicMessages: [...byTopic].map(([topic, ms]) => ({
        topic,
        messages: ms.map((m) => ({ key: m.key, value: m.value, headers: m.headers })),
      })),
    });
  }

  async close(): Promise<void> {
    await this.producer.disconnect();
  }
}
