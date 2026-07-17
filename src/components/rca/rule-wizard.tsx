import { type ReactNode, useState, useCallback } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/* ==========================================================================
 *  RuleWizard — Progressive Disclosure Wizard for Alert-to-RCA Rule Config
 *
 *  Exactly 4 steps with step indicator, Back/Next navigation, and validation.
 *  Each step is a controlled content area.
 *
 *  Usage:
 *    <RuleWizard
 *      steps={[
 *        { id: "trigger", label: "触发条件", content: <TriggerForm /> },
 *        { id: "condition", label: "条件配置", content: <ConditionForm /> },
 *        { id: "action", label: "动作设置", content: <ActionForm /> },
 *        { id: "review", label: "审核确认", content: <ReviewSummary /> },
 *      ]}
 *      onComplete={handleCreate}
 *      validationErrors={errors}
 *    />
 * ========================================================================== */

/* ---- Step Definition ---- */

export interface WizardStep {
  /** Unique step identifier */
  id: string;
  /** Display label shown in the step indicator */
  label: string;
  /** Short description shown below the indicator */
  description?: string;
  /** Content rendered for this step */
  content: ReactNode;
}

/* ---- Validation Result ---- */

export interface WizardValidation {
  /** Map of step index to error message */
  errors: Record<number, string | undefined>;
}

/* ---- Main RuleWizard Component ---- */

export interface RuleWizardProps {
  /** Exactly 4 steps */
  steps: [WizardStep, WizardStep, WizardStep, WizardStep];
  /** Called when the user clicks "Confirm" on the final step */
  onComplete?: () => void;
  /** Called when the wizard is cancelled */
  onCancel?: () => void;
  /** External validation errors (keyed by step index) */
  validationErrors?: Record<number, string | undefined>;
  /** Allow clicking completed steps to jump back (default: true) */
  allowReviewNavigation?: boolean;
  /** Show submitting state on the confirm button */
  isSubmitting?: boolean;
}

export function RuleWizard({
  steps,
  onComplete,
  onCancel,
  validationErrors = {},
  allowReviewNavigation = true,
  isSubmitting = false,
}: RuleWizardProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);

  const totalSteps = steps.length;
  const isFirstStep = currentStep === 0;
  const isLastStep = currentStep === totalSteps - 1;
  const currentError = validationErrors[currentStep];

  const handleNext = useCallback(() => {
    if (currentError) return; // don't proceed if validation error
    if (currentStep < totalSteps - 1) {
      setCurrentStep((prev) => prev + 1);
    }
  }, [currentStep, totalSteps, currentError]);

  const handleBack = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep((prev) => prev - 1);
    }
  }, [currentStep]);

  const handleCancelClick = useCallback(() => {
    setCancelConfirmOpen(true);
  }, []);

  const handleCancelConfirm = useCallback(() => {
    setCancelConfirmOpen(false);
    onCancel?.();
  }, [onCancel]);

  const handleStepClick = useCallback(
    (index: number) => {
      // Allow clicking completed steps or the current step
      if (allowReviewNavigation && (index <= currentStep)) {
        setCurrentStep(index);
      }
    },
    [currentStep, allowReviewNavigation]
  );

  return (
    <div className="flex flex-col h-full bg-surface-primary" role="form" aria-label="规则配置向导">
      {/* ================================================================ */}
      {/* Step Indicator                                                  */}
      {/* ================================================================ */}
      <div
        className="flex items-center justify-center gap-0 py-6 px-4 border-b border-border"
        role="tablist"
        aria-label="规则配置步骤"
      >
        {steps.map((step, index) => (
          <div key={step.id} className="flex items-center">
            <button
              type="button"
              role="tab"
              aria-selected={currentStep === index}
              aria-controls={`wizard-panel-${index}`}
              disabled={index > currentStep && !allowReviewNavigation}
              onClick={() => handleStepClick(index)}
              className={cn(
                "flex items-center gap-1.5 md:gap-2 px-2 md:px-3 py-2 rounded-lg transition-colors",
                currentStep === index &&
                  "bg-interactive-primary/10 text-interactive-primary",
                currentStep > index && "text-status-resolved",
                currentStep < index && "text-muted-foreground",
                (index > currentStep && !allowReviewNavigation) &&
                  "cursor-not-allowed opacity-50"
              )}
            >
              {/* Step circle */}
              {currentStep > index ? (
                <CheckCircle2 className="h-5 w-5 shrink-0" />
              ) : (
                <span
                  className={cn(
                    "flex items-center justify-center h-5 w-5 rounded-full border text-[11px] font-semibold shrink-0",
                    currentStep === index
                      ? "border-interactive-primary bg-interactive-primary text-primary-foreground"
                      : "border-border text-muted-foreground"
                  )}
                >
                  {index + 1}
                </span>
              )}
              <span className="text-xs md:text-sm font-medium hidden md:inline">
                {step.label}
              </span>
            </button>

            {/* Connector line */}
            {index < totalSteps - 1 && (
              <div
                className={cn(
                  "w-6 md:w-12 h-px mx-1 md:mx-2",
                  currentStep > index ? "bg-status-resolved" : "bg-border"
                )}
              />
            )}
          </div>
        ))}
      </div>

      {/* ================================================================ */}
      {/* Step Content                                                    */}
      {/* ================================================================ */}
      <div className="flex-1 overflow-auto p-4 md:p-6">
        {/* Step header */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-foreground">
            {steps[currentStep].label}
          </h2>
          {steps[currentStep].description && (
            <p className="text-sm text-muted-foreground mt-1">
              {steps[currentStep].description}
            </p>
          )}
        </div>

        {/* Validation error banner */}
        {currentError && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>请修正以下错误</AlertTitle>
            <AlertDescription>{currentError}</AlertDescription>
          </Alert>
        )}

        {/* Step content area */}
        <div
          key={currentStep}
          id={`wizard-panel-${currentStep}`}
          role="tabpanel"
          aria-labelledby={`wizard-tab-${currentStep}`}
          className="animate-in fade-in duration-fast"
        >
          {steps[currentStep].content}
        </div>
      </div>

      {/* ================================================================ */}
      {/* Navigation Footer                                               */}
      {/* ================================================================ */}
      <div className="flex items-center justify-between px-4 md:px-6 py-4 border-t border-border bg-surface-secondary shrink-0">
        <div className="flex items-center gap-2">
          {isFirstStep && onCancel && (
            <Button variant="ghost" onClick={handleCancelClick}>
              取消
            </Button>
          )}
          {!isFirstStep && (
            <Button
              variant="outline"
              onClick={handleBack}
              aria-label="上一步"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              上一步
            </Button>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            步骤 {currentStep + 1} / {totalSteps}
          </span>

          {!isLastStep ? (
            <Button
              onClick={handleNext}
              disabled={!!currentError}
              aria-label="下一步"
            >
              下一步
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          ) : (
            <Button
              onClick={onComplete}
              variant="default"
              disabled={!!currentError || isSubmitting}
              aria-label={isSubmitting ? "正在提交" : "确认创建"}
            >
              {isSubmitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {isSubmitting ? "提交中..." : "确认创建"}
            </Button>
          )}
        </div>
      </div>

      {/* Cancel confirmation dialog */}
      <ConfirmDialog
        open={cancelConfirmOpen}
        onOpenChange={setCancelConfirmOpen}
        title="放弃更改？"
        description="您输入的规则配置尚未保存，确定要放弃吗？"
        confirmLabel="放弃"
        cancelLabel="继续编辑"
        variant="destructive"
        onConfirm={handleCancelConfirm}
      />
    </div>
  );
}
