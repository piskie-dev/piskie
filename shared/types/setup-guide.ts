export interface SetupGuideStep {
  title: string;
  description: string;
  link?: { text: string; url: string };
}

export interface SetupGuide {
  consoleURL: string;
  steps: SetupGuideStep[];
  notes?: string[];
  links?: Array<{ text: string; url: string }>;
}
