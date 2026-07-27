"use client";

import { TextField as MuiTextField, type TextFieldProps as MuiTextFieldProps } from "@mui/material";

interface InputProps extends Omit<MuiTextFieldProps, "variant"> {
  label?: string;
}

export default function Input({ label, sx, ...rest }: InputProps) {
  return (
    <MuiTextField
      label={label}
      variant="outlined"
      fullWidth
      slotProps={{
        input: {
          sx: {
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-base)",
          },
        },
        inputLabel: {
          sx: {
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-sm)",
          },
        },
      }}
      sx={{
        "& .MuiOutlinedInput-root": {
          borderRadius: "2px",
          "& fieldset": { borderColor: "var(--color-border-default)" },
        },
        ...(typeof sx === "function" ? {} : sx),
      }}
      {...rest}
    />
  );
}
