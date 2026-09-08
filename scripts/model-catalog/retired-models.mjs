export function retainRetiredModels(previous, current) {
  const ids = new Set(current.map((model) => model.id));
  return [
    ...current,
    ...previous.filter((model) => !ids.has(model.id)).map((model) => ({
      ...model,
      lifecycle: 'retired',
    })),
  ];
}
