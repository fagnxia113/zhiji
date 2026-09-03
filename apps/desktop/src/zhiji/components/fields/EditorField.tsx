type EditorFieldProps = {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
};

export function EditorField({ label, hint, value, onChange, placeholder }: EditorFieldProps) {
  return (
    <div className="editor-field">
      <div>
        <h3>{label}</h3>
        <small>{hint}</small>
      </div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
