export class Service {
  id: string;
  type: string;
  serviceEndpoint: string | object;

  constructor(data: Partial<Service>) {
    this.id = data.id!;
    this.type = data.type!;
    this.serviceEndpoint = data.serviceEndpoint!;
  }

  toJSON(): object {
    return {
      id: this.id,
      type: this.type,
      serviceEndpoint: this.serviceEndpoint,
    };
  }
}
