import { type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/* ==========================================================================
 *  ConfirmDialog — Confirmation Dialog for Destructive Actions
 *
 *  Follows copy.md Section 2.5 patterns for destructive action confirmation.
 *  Supports three variants: "destructive" (delete/stop/dismiss), "default".
 *
 *  Usage:
 *    <ConfirmDialog
 *      open={isOpen}
 *      onOpenChange={setIsOpen}
 *      title="删除规则"
 *      description="确定要删除规则「xxx」吗？此操作不可撤销。"
 *      confirmLabel="删除"
 *      variant="destructive"
 *      onConfirm={handleDelete}
 *    />
 * ========================================================================== */

export interface ConfirmDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Called when the open state should change */
  onOpenChange: (open: boolean) => void;
  /** Dialog title */
  title: string;
  /** Dialog description / body content */
  description: ReactNode;
  /** Label for the confirm button */
  confirmLabel: string;
  /** Label for the cancel button (default: "取消") */
  cancelLabel?: string;
  /** Variant for the confirm button */
  variant?: "destructive" | "default";
  /** Called when the user confirms the action */
  onConfirm: () => void;
  /** Called when the dialog is dismissed */
  onCancel?: () => void;
  /** Show loading state on confirm button */
  isLoading?: boolean;
  /** Disable the confirm button */
  disabled?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "取消",
  variant = "default",
  onConfirm,
  onCancel,
  isLoading = false,
  disabled = false,
}: ConfirmDialogProps) {
  const handleConfirm = () => {
    onConfirm();
  };

  const handleCancel = () => {
    onCancel?.();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {typeof description === "string" ? (
            <DialogDescription>{description}</DialogDescription>
          ) : (
            <div className="text-sm text-muted-foreground">{description}</div>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={isLoading}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant}
            onClick={handleConfirm}
            disabled={disabled || isLoading}
          >
            {isLoading ? "处理中..." : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
