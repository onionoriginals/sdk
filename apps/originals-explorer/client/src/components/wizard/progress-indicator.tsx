interface ProgressIndicatorProps {
  currentStep: number;
  totalSteps: number;
  steps: Array<{
    id: number;
    name: string;
    description?: string;
  }>;
}

export function ProgressIndicator({ currentStep, totalSteps, steps }: ProgressIndicatorProps) {
  return (
    <div className="flex items-center justify-center space-x-4 mb-8">
      {steps.map((step, index) => (
        <div key={step.id} className="flex items-center">
          <div className="flex items-center">
            <div 
              className={`wizard-step ${
                step.id <= currentStep ? 'wizard-step-active' : 'wizard-step-inactive'
              }`}
              data-testid={`step-${step.id}`}
            >
              {step.id}
            </div>
            <span 
              className={`ml-2 text-sm font-medium ${
                step.id <= currentStep ? 'text-accent' : 'text-neutral-500'
              }`}
            >
              {step.name}
            </span>
          </div>
          {index < steps.length - 1 && (
            <div className="w-16 h-px bg-neutral-200 ml-4" />
          )}
        </div>
      ))}
    </div>
  );
}
